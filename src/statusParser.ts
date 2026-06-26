// SVN status 输出解析（纯函数，便于单元测试）

export interface ChangedEntry {
    /** 主状态字符，如 M / A / D / ? 等 */
    status: string;
    /** 相对工作副本根目录的路径，使用原始分隔符 */
    path: string;
}

/** 需要跳过的状态：X 外部、I 忽略、空白 无变更、! 文件丢失（无法导出） */
const SKIP_STATUS = new Set(['X', 'I', ' ', '!']);

/**
 * 解析 `svn status` 的单行输出。
 *
 * SVN status 行格式：前若干列为状态标记（第 1 列是主状态），
 * 路径从第 8 列开始。这里不按固定下标 trim 整行，而是：
 *   - 先剥离行尾的 \r（兼容 Windows CRLF）
 *   - 主状态取第 1 个字符
 *   - 路径取第 8 列之后的内容，仅裁剪左侧空白，
 *     保留文件名本身可能存在的首尾空格
 *
 * @returns 解析结果；若该行应被跳过或不合法则返回 null
 */
export function parseStatusLine(rawLine: string): ChangedEntry | null {
    // 仅去掉行尾换行符，避免破坏文件名首尾空格
    const line = rawLine.replace(/[\r\n]+$/, '');
    if (line.length < 8) {
        return null;
    }
    const status = line[0];
    if (SKIP_STATUS.has(status)) {
        return null;
    }
    // 路径从第 8 列开始；前 7 列是状态标记区，用左裁剪去掉它们之间的填充空格
    const filePath = line.substring(7).replace(/^\s+/, '');
    if (!filePath) {
        return null;
    }
    return { status, path: filePath };
}
