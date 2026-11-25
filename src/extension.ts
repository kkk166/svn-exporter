import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseStatusLine } from './statusParser';
import { execSvn, exportRemoteFile, findRemoteUpdates } from './svn';

export function activate(context: vscode.ExtensionContext) {
    console.log('SVN 导出扩展已激活');

    context.subscriptions.push(
        vscode.commands.registerCommand('svn-exporter.export', exportLocalChanges),
        vscode.commands.registerCommand('svn-exporter.exportRemote', exportRemoteUpdates)
    );
}

/** 导出本地工作副本中的变更文件（直接复制磁盘上的文件） */
async function exportLocalChanges(): Promise<void> {
    const rootPath = await pickWorkingCopy();
    if (!rootPath) {
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

        const targetDir = await pickTargetFolder();
        if (!targetDir) {
            return;
        }
        const targetRoot = path.join(targetDir, path.basename(rootPath));

        await exportWithProgress('变更文件', changedFiles, targetRoot, async ({ status, path: relPath }, dest) => {
            if (status === 'D') {
                return false;
            }
            const src = path.join(rootPath, relPath);
            if (!fs.existsSync(src)) {
                console.warn(`文件不存在，跳过: ${relPath}`);
                return false;
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            return true;
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`执行SVN命令失败: ${msg}`);
    }
}

/** 导出远程仓库中尚未更新到本地的文件（内容从服务器获取，不改动工作副本） */
async function exportRemoteUpdates(): Promise<void> {
    const rootPath = await pickWorkingCopy();
    if (!rootPath) {
        return;
    }

    try {
        // 需要联网，可能较慢，先给出提示
        const updates = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在检查远程更新...'
        }, () => findRemoteUpdates(rootPath));

        if (updates.files.length === 0) {
            vscode.window.showInformationMessage('远程没有需要导出的更新文件');
            return;
        }

        const targetDir = await pickTargetFolder();
        if (!targetDir) {
            return;
        }
        // 目录名带上版本号：既标明内容对应的远程版本，也避免和本地导出的目录互相覆盖
        const targetRoot = path.join(targetDir, `${path.basename(rootPath)}-r${updates.revision}`);

        const items = updates.files.map(file => ({ path: file }));
        await exportWithProgress('远程更新文件', items, targetRoot,
            (item, dest) => exportRemoteFile(updates, item.path, dest));
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`执行SVN命令失败: ${msg}`);
    }
}

/** 确定要操作的工作区文件夹，并确认它是 SVN 工作副本。用户取消或检查不通过时返回 undefined */
async function pickWorkingCopy(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('请先打开一个文件夹');
        return undefined;
    }
    // 多根工作区下让用户明确选择，避免悄悄只导出第一个文件夹
    const workspaceFolder = folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择要导出变更的文件夹' });
    if (!workspaceFolder) {
        return undefined;
    }
    const rootPath = workspaceFolder.uri.fsPath;

    try {
        await execSvn(['info'], rootPath);
    } catch (e) {
        vscode.window.showErrorMessage('当前目录不是 SVN 工作副本，或 svn 命令不可用');
        return undefined;
    }
    return rootPath;
}

async function pickTargetFolder(): Promise<string | undefined> {
    const targetUri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: '选择导出目标文件夹',
        openLabel: '选择'
    });
    return targetUri?.[0].fsPath;
}

/**
 * 逐个导出 items，显示进度并支持取消，结束后汇报结果。
 *
 * @param what 导出内容的称呼，用于提示文字
 * @param exportOne 导出单个条目到 dest，返回是否实际写出了文件；抛出异常视为该条目失败
 */
async function exportWithProgress<T extends { path: string }>(
    what: string,
    items: T[],
    targetRoot: string,
    exportOne: (item: T, dest: string) => Promise<boolean>
): Promise<void> {
    let copiedCount = 0;
    let cancelled = false;
    // 失败逐条记录、最后只提示一次：远程导出遇到网络或认证问题时会整批失败，逐条弹窗会刷屏
    const failures: string[] = [];
    const total = items.length;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `正在导出${what}...`,
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(() => {
            cancelled = true;
        });
        for (let i = 0; i < total; i++) {
            if (cancelled) {
                break;
            }
            const item = items[i];
            try {
                if (await exportOne(item, path.join(targetRoot, item.path))) {
                    copiedCount++;
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`导出失败: ${item.path} - ${msg}`);
                failures.push(`${item.path} - ${msg}`);
            }

            progress.report({
                message: `已处理 ${i + 1}/${total} 个文件`,
                increment: 100 / total
            });
        }
    });

    if (cancelled) {
        vscode.window.showWarningMessage(`⚠️ 导出已取消，已复制 ${copiedCount} 个文件`);
    } else if (failures.length > 0) {
        vscode.window.showWarningMessage(
            `⚠️ 导出完成：成功 ${copiedCount} 个，失败 ${failures.length} 个。首个失败: ${failures[0]}`
        );
    } else {
        vscode.window.showInformationMessage(`✅ 成功导出 ${copiedCount} 个${what}到 ${targetRoot}`);
    }
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
