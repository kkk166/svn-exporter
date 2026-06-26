# 更新日志

所有显著的版本变更都会记录在此文件。

## [0.0.2] - 2026-06-26

### 修复

- 提升 `svn status` 路径解析健壮性，正确保留文件名首尾空格，兼容 CRLF 行尾
- Windows 下改为异步执行 svn 命令，不再阻塞扩展主线程
- 使用参数数组调用 svn，避免路径/参数注入风险
- 声明 `iconv-lite` 运行时依赖，修复打包后 GBK 解码缺失

## [0.0.1] - 2026-06-25

### 新增

- 一键导出 SVN 变更文件到指定文件夹
- 保留完整的项目目录结构
- 自动忽略 SVN 外部定义和忽略项
- 跳过已删除文件，显示导出进度通知
- 支持 SCM 面板快捷按钮

[0.0.2]: https://github.com/kkk166/svn-exporter/releases/tag/v0.0.2
[0.0.1]: https://github.com/kkk166/svn-exporter/releases/tag/v0.0.1
