import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
            await execPromise('svn info', { cwd: rootPath });
        } catch (e) {
            vscode.window.showErrorMessage('当前目录不是 SVN 工作副本，或 svn 命令不可用');
            return;
        }

        const svnCmd = 'svn status -q';
        try {
            const { stdout } = await execPromise(svnCmd, { cwd: rootPath });
            const lines = stdout.split('\n').filter(line => line.trim() !== '');

            const changedFiles: { status: string; path: string }[] = [];
            for (const line of lines) {
                // SVN status 输出格式：前 7 列为状态标记，之后是路径
                // 去掉首尾空白后，第 1 个字符是主状态，路径从第 8 个字符开始
                const trimmed = line.trimEnd();
                if (trimmed.length < 8) {
                    continue;
                }
                const status = trimmed[0];
                // 过滤掉 X（外部）和 I（忽略），保留 ?、M、A、D 等
                if (status === 'X' || status === 'I') {
                    continue;
                }
                const filePath = trimmed.substring(7).trim();
                if (filePath) {
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
                        increment: (1/total) * 100
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

function execPromise(cmd: string, options: child_process.ExecOptions): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        child_process.exec(cmd, options, (err, stdout, stderr) => {
            if (err) {
                reject(err);
            } else {
                resolve({ stdout: String(stdout), stderr: String(stderr) });
            }
        });
    });
}

export function deactivate() {}