// SVN status 输出解析（纯函数，便于单元测试）

export interface ChangedEntry {
    /** 主状态字符，如 M / A / D / ? 等 */
    status: string;
    /** 相对工作副本根目录的路径，使用原始分隔符 */
    path: string;
}

/**
 * 合法状态行的格式：7 个状态列 + 1 个空格 + 路径。
 *
 * 用白名单而不是“跳过黑名单”，是因为 `svn status` 还会输出非状态行
 * （changelist 标题、冲突汇总、外部项提示等），黑名单会把它们误判成文件。
 *
 * 第 1 列只接受有内容变更的状态（A 新增、C 冲突、D 删除、M 修改、R 替换、
 * ? 未纳入版本控制、~ 类型变化），因此以下情况都不匹配：
 *   - X 外部、I 忽略、! 文件丢失（无法导出）
 *   - 第 1 列为空白的行：包括只改了属性的文件——复制带不走 SVN 属性，
 *     导出的文件内容与仓库一致，没有意义
 * 第 2~7 列分别是属性、锁定、历史、切换、锁令牌、树冲突标记。
 */
const STATUS_LINE = /^([ACDMR?~])[ CM][ L][ +][ SX][ KOTB][ C] (.+)$/;

/**
 * 解析 `svn status` 的单行输出。
 *
 * 仅剥离行尾换行符（兼容 Windows CRLF），不 trim 整行，
 * 以保留文件名本身可能存在的首尾空格。
 *
 * @returns 解析结果；若该行应被跳过或不是状态行则返回 null
 */
export function parseStatusLine(rawLine: string): ChangedEntry | null {
    const line = rawLine.replace(/[\r\n]+$/, '');
    const match = STATUS_LINE.exec(line);
    if (!match) {
        return null;
    }
    return { status: match[1], path: match[2] };
}
