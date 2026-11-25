// svn 命令行调用。不依赖 vscode，便于在测试中直接使用。

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { parseInfoUrl, parseRemoteStatus } from './remoteStatusParser';

/**
 * 异步执行 svn 命令。用参数数组而非 shell 字符串，避免路径/参数注入，也不阻塞扩展主线程。
 *
 * 统一加 --non-interactive：没有缓存凭据时让 svn 直接报错，而不是挂起等待输入密码。
 */
export function execSvn(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    // Windows 下 SVN 的文本输出是 GBK 编码，统一以 Buffer 获取后再解码；
    // 但 --xml 输出在所有平台都固定为 UTF-8。
    const decodeText = (buf: Buffer) =>
        process.platform === 'win32' ? iconv.decode(buf, 'gbk') : buf.toString('utf8');
    const decodeStdout = args.includes('--xml') ? (buf: Buffer) => buf.toString('utf8') : decodeText;

    return new Promise((resolve, reject) => {
        child_process.execFile('svn', [...args, '--non-interactive'], {
            cwd,
            encoding: 'buffer',
            maxBuffer: 10 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            if (err) {
                // 错误信息也需要转码，优先用 stderr
                const detail = stderr && stderr.length ? decodeText(stderr) : decodeStdout(stdout ?? Buffer.alloc(0));
                if (detail.trim()) {
                    err.message = detail.trim();
                }
                reject(err);
            } else {
                resolve({ stdout: decodeStdout(stdout), stderr: decodeText(stderr) });
            }
        });
    });
}

/**
 * 拼出文件在仓库中的 URL。
 *
 * @param baseUrl 目录的仓库 URL，来自 `svn info`，已做百分号编码
 * @param relPath 相对该目录的路径，/ 分隔，未编码
 */
export function buildFileUrl(baseUrl: string, relPath: string): string {
    // 逐段编码：@ 不编码会被 svn 当成版本限定符，# ? % 不编码会破坏 URL
    return `${baseUrl}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

export interface RemoteUpdates {
    /** 被检查目录的仓库 URL */
    url: string;
    /** 检查时的远程版本号，导出时固定取这个版本，避免中途有新提交导致内容不一致 */
    revision: number;
    /** 远程有内容更新的文件，相对被检查目录，/ 分隔 */
    files: string[];
}

/** 联网查询 rootPath 下有哪些文件在远程有更新（尚未 svn update 到本地的提交） */
export async function findRemoteUpdates(rootPath: string): Promise<RemoteUpdates> {
    const info = await execSvn(['info', '--xml'], rootPath);
    const status = await execSvn(['status', '-u', '--xml'], rootPath);

    const url = parseInfoUrl(info.stdout);
    const { revision, paths } = parseRemoteStatus(status.stdout, path.sep);
    if (!url || revision === null) {
        throw new Error('无法解析 svn 输出');
    }

    // 解析器只能认出“带着子条目一起列出”的目录；本地已存在的目录在这里排除
    const files = paths.filter(
        p => !fs.statSync(path.join(rootPath, p), { throwIfNoEntry: false })?.isDirectory()
    );
    return { url, revision, files };
}

/**
 * 从仓库取出 relPath 在 updates.revision 版本的内容，写到 dest。
 *
 * @returns 是否写出了文件。远程新增的空目录无法在导出前识别，会得到 false。
 */
export async function exportRemoteFile(updates: RemoteUpdates, relPath: string, dest: string): Promise<boolean> {
    // svn export 不会创建目标的上级目录
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await execSvn([
        'export', '--force', '-q',
        // 万一条目其实是目录，只建空目录，不把整棵目录树拉下来
        '--depth', 'empty',
        `${buildFileUrl(updates.url, relPath)}@${updates.revision}`,
        // svn 会把目标路径中最后一个 @ 之后的内容当成版本限定符（a@b.txt 会变成 a），
        // 末尾补一个 @ 表示“没有版本限定符”
        `${dest}@`,
    ], path.dirname(dest));
    return (await fs.promises.stat(dest)).isFile();
}
