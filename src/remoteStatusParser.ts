// `svn status -u --xml` 与 `svn info --xml` 输出解析（纯函数，便于单元测试）
//
// 用 XML 而不是文本输出，是因为 XML 固定为 UTF-8，不受 Windows 控制台代码页影响，
// 且远程状态有明确的字段，不必按列猜测。

export interface RemoteChanges {
    /** 对比所用的远程版本号；输出中缺失时为 null */
    revision: number | null;
    /** 远程有内容更新的路径，相对被检查的目录，统一使用 / 分隔 */
    paths: string[];
}

/**
 * 需要导出的远程状态。不含 deleted（远程已无内容可取）；
 * 只改属性的条目 item 为 none，同样不导出，与本地导出的规则一致。
 */
const EXPORTABLE_ITEMS = new Set(['added', 'modified', 'replaced']);

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
        if (entity.startsWith('#x')) {
            return String.fromCodePoint(parseInt(entity.substring(2), 16));
        }
        if (entity.startsWith('#')) {
            return String.fromCodePoint(parseInt(entity.substring(1), 10));
        }
        return XML_ENTITIES[entity];
    });
}

/**
 * 解析 `svn status -u --xml` 的输出，找出远程有内容更新的文件。
 *
 * @param sep 输出中路径所用的分隔符（即运行 svn 的平台的 path.sep）
 */
export function parseRemoteStatus(xml: string, sep: string): RemoteChanges {
    const against = /<against\s+revision="(\d+)"/.exec(xml);
    const revision = against ? Number(against[1]) : null;

    const candidates: string[] = [];
    // 输出不标注条目是文件还是目录。远程新增的目录会和它下面的文件一起列出，
    // 所以凡是作为其他条目父路径出现的，都按目录处理。
    const directories = new Set<string>();

    for (const match of xml.matchAll(/<entry\b([^>]*)>([\s\S]*?)<\/entry>/g)) {
        const rawPath = /\bpath="([^"]*)"/.exec(match[1]);
        if (!rawPath) {
            continue;
        }
        const entryPath = decodeXml(rawPath[1]).split(sep).join('/');
        for (let i = entryPath.indexOf('/'); i !== -1; i = entryPath.indexOf('/', i + 1)) {
            directories.add(entryPath.substring(0, i));
        }

        const reposStatus = /<repos-status\b([^>]*)>/.exec(match[2]);
        const item = reposStatus && /\bitem="([^"]*)"/.exec(reposStatus[1]);
        if (item && EXPORTABLE_ITEMS.has(item[1])) {
            candidates.push(entryPath);
        }
    }

    // "." 是被检查的目录自身
    const paths = candidates.filter(p => p !== '.' && !directories.has(p));
    return { revision, paths };
}

/** 从 `svn info --xml` 的输出中取出目录对应的仓库 URL（已做百分号编码） */
export function parseInfoUrl(xml: string): string | null {
    const match = /<url>([^<]*)<\/url>/.exec(xml);
    return match ? decodeXml(match[1]) : null;
}
