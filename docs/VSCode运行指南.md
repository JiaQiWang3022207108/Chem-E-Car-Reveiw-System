# VS Code 本地运行（方案 A）

## 一次设置，以后 F5 启动

1. 安装 Node.js 24 LTS 和 VS Code。当前电脑已验证 Node.js 24.19.0。
2. 在 VS Code 中选择“文件 → 从文件打开工作区”，打开根目录 `Chem-E-Car.code-workspace`。
3. 第一次打开终端，执行 `npm run local:setup`。脚本安装锁定依赖，并生成本机专用登录配置；不覆盖已有配置。
4. 按 F5，选择“网站：运行与调试（Edge）”。打开 `http://localhost:3000/`。
5. 本机初始密码保存在 `.local/本地登录信息.txt`。不要分享该文件，也不要把 `.dev.vars` 加入版本库。公开网站密码没有改变。

也可执行 `npm run dev -- --hostname localhost --port 3000` 后手动打开上述地址。
如果 Windows 阻止 `npm.ps1`，使用 `npm.cmd` 执行相同命令，无须放宽系统执行策略。
如端口已占用，先关闭自己此前启动的开发终端；不要结束不认识的进程。
按 Ctrl+C 停止服务，文件和本地数据库仍会保留。

## 本地与线上资料相互独立

- 本地数据库、上传文件位于 `.local/runtime-state`，不会同步或清空线上 D1/R2。
- 旧预览的 `.wrangler/state` 原样保留，不自动导入，更不会删除。
- 初次本地启动显示空资料库是正常现象。导入测试报名表或 EDP 后即可测试流程。
- 重复执行初始化不重置密码。若曾在网页重置密码，以本地数据库中保存的新密码为准，初始密码文件不会反向覆盖它。
- 邮箱/凡科联动依赖用户本人登录与浏览器助手；本地验证不会自动向邮箱发送邮件。
- 本地调试未配置线上凭据，不会因为按 F5 就公开发布。

## EDP 的简化操作

1. 设置竞赛年份、提交轮次，上传 ZIP、7z 或 RAR。
2. 提交格式合格后自动建立审核任务。登录页面保持打开时持续处理队列，无须逐校点审核。
3. 打开“EDP 审核”，点击“查看审核结果”。可查看每项结论、意见、PDF 文件名和页码。
4. 按需要点“下载 Excel”“下载所选结果”或“一键下载全部已完成”。多人文件打包为 ZIP，每所学校一个双工作表 Excel。
5. 修改原文件后重新提交，或在“重新审核”菜单中重新排队。审核与下载相互独立。

一次只处理一所学校，避免把多份图片 PDF 和 Excel 同时堆在内存中。
线上定时任务每 5 分钟补处理一所，浏览器关闭时仍可慢速推进；本地普通开发服务器没有自动触发云端定时任务，因此保持本地网页打开。
异常退出超过 10 分钟的任务会显示失败并可重试，不会一直停在“正在审核”。
已经因旧解析器失败而未入库的压缩包需要重新上传/收集；系统不能从旧错误记录还原没有保存的原文件。

## C++ 源码和重新编译

直接运行网站**不需要**额外安装 C++ 工具，因为项目包含编译好的 `native/edp_core.wasm`。
修改 `native/edp_core.cpp` 后运行 `npm run native:build`，再运行 `npm run native:test`。

- 当前 Windows 电脑：脚本使用 WSL 的 Ubuntu-24.04 / clang 18 / lld 18。
- 其他 Windows 电脑：可安装 WSL Ubuntu-24.04 的 clang/lld，或设置 `CXX` 指向带 WASM 链接器的 LLVM clang++。
- Linux/macOS：使用带 wasm32 支持的 clang++，或者通过 `CXX` 指定路径。
- WSL 发行版名称不同可设置 `WSL_DISTRO`。项目不会自动修改系统编译器设置。
- 原生单元测试也可通过 `cmake -S native -B native/build`、`cmake --build native/build`、`ctest --test-dir native/build` 运行（需自行安装 CMake/C++ 编译器）。

## 验证命令

| 命令 | 用途 |
|---|---|
| `npm test` | 生产构建 + 完整自动化回归 |
| `npm run typecheck` | VS Code 所用的严格类型检查 |
| `npm run lint` | 代码/界面静态检查 |
| `npm run test:runtime` | 真正的 workerd 运行环境：登录、收集、审核、预览、双工作表导出 |
| `npm run test:runtime -- --archive "绝对路径.7z" --school "学校名" --round 3` | 只在临时本地数据库测试实际压缩包，不上传到公开网站 |
| `npm run native:build` | 重新编译 C++ 核心 |
| `npm run native:test` | 验证生成的真实 WASM 核心 |

测试通过证明软件流程在所测文件上可运行，不代表每校化学安全方案自动获得批准。
手写签名真实性、扫描图片内容等不能仅凭存在图像对象判定；证据不足时仍需人工复核。
