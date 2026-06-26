import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { parseStatusLine } from './statusParser';

export function activate(context: vscode.ExtensionContext) {
    console.log('SVN 导出扩展已激活');

    let disposable = vscode.commands.registerCommand('svn-exporter.export', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('请先打开一个文件夹');
            return;
        }
        const rootPath = workspaceFolder.uri.fsPath;

        // 检查 SVN 是否可用
        try {
            await execSvn(['info'], rootPath);
        } catch (e) {
            vscode.window.showErrorMessage('当前目录不是 SVN 工作副本，或 svn 命令不可用');
            return;
        }

        // 不用 -q（会隐藏 ? 文件），不用 --no-ignore（会包含忽略列表中的文件）
        try {
            const { stdout } = await execSvn(['status'], rootPath);
            const lines = stdout.split('\n');

            const changedFiles: { status: string; path: string }[] = [];
            for (const line of lines) {
                const parsed = parseStatusLine(line);
                if (!parsed) {
                    continue;
                }
                const { status, path: filePath } = parsed;
                // 如果是目录，递归获取目录下的所有文件
                const fullPath = path.join(rootPath, filePath);
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                    const files = getAllFiles(fullPath);
                    for (const f of files) {
                        const relPath = path.relative(rootPath, f).replace(/\\/g, '/');
                        changedFiles.push({ status, path: relPath });
                    }
                } else {
                    changedFiles.push({ status, path: filePath });
                }
            }

            if (changedFiles.length === 0) {
                vscode.window.showInformationMessage('没有需要导出的变更文件');
                return;
            }

            const targetUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                title: '选择导出目标文件夹',
                openLabel: '选择'
            });
            if (!targetUri) {
				return;
            }
            const targetRoot = path.join(targetUri[0].fsPath, path.basename(rootPath));

            let copiedCount = 0;
            let cancelled = false;
            const total = changedFiles.length;
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在导出变更文件...`,
                cancellable: true
            }, async (progress, token) => {
                token.onCancellationRequested(() => {
                    cancelled = true;
                });
                for (let i = 0; i < changedFiles.length; i++) {
                    if (cancelled) {
                        break;
                    }
                    const { status, path: relPath } = changedFiles[i];
                    const src = path.join(rootPath, relPath);
                    const dest = path.join(targetRoot, relPath);

                    if (status === 'D') {
                        continue;
                    }
                    if (!fs.existsSync(src)) {
                        console.warn(`文件不存在，跳过: ${relPath}`);
                        continue;
                    }

                    try {
                        const destDir = path.dirname(dest);
                        if (!fs.existsSync(destDir)) {
                            fs.mkdirSync(destDir, { recursive: true });
                        }
                        fs.copyFileSync(src, dest);
                        copiedCount++;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        vscode.window.showWarningMessage(`复制失败: ${relPath} - ${msg}`);
                    }

                    progress.report({
                        message: `已复制 ${i+1}/${total} 个文件`,
                        increment: 100 / total
                    });
                }
            });

            if (cancelled) {
                vscode.window.showWarningMessage(`⚠️ 导出已取消，已复制 ${copiedCount} 个文件`);
            } else {
                vscode.window.showInformationMessage(`✅ 成功导出 ${copiedCount} 个变更文件到 ${targetRoot}`);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`执行SVN命令失败: ${msg}`);
        }
    });

    context.subscriptions.push(disposable);
}

// 异步执行 svn 命令。用参数数组而非 shell 字符串，避免路径/参数注入，也不阻塞扩展主线程。
// Windows 下 SVN 输出 GBK 编码，统一以 Buffer 获取后再解码。
function execSvn(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        child_process.execFile('svn', args, {
            cwd,
            encoding: 'buffer',
            maxBuffer: 10 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            const decode = (buf: Buffer) =>
                process.platform === 'win32' ? iconv.decode(buf, 'gbk') : buf.toString('utf8');
            if (err) {
                // 错误信息也需要转码，优先用 stderr
                const detail = stderr && stderr.length ? decode(stderr as Buffer) : decode((stdout as Buffer) ?? Buffer.alloc(0));
                if (detail.trim()) {
                    err.message = detail.trim();
                }
                reject(err);
            } else {
                resolve({ stdout: decode(stdout as Buffer), stderr: decode(stderr as Buffer) });
            }
        });
    });
}

// 递归获取目录下所有文件
function getAllFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...getAllFiles(fullPath));
        } else if (entry.isFile()) {
            results.push(fullPath);
        }
    }
    return results;
}

export function deactivate() {}