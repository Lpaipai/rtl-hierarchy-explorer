# RTL Hierarchy Explorer

本地 Verilog/SystemVerilog 实例层次浏览器。打开工程、选定文件范围、查看实例并跳转源码；无需综合。

当前源码版本 **1.0.2，MIT 开源**。Windows x64 默认使用 slang 12.0 展开已保存的 RTL；保留 Tree-sitter 静态模式，实时查看编辑中的语法关系。VS Code 原生 Tree View，运行时离线。

[源码与版本发布](https://github.com/Lpaipai/rtl-hierarchy-explorer) · [问题反馈](https://github.com/Lpaipai/rtl-hierarchy-explorer/issues) · [Marketplace](https://marketplace.visualstudio.com/items?itemName=liaoweipeng1.rtl-hierarchy-explorer)

## 安装与使用

1. 在 VS Code 扩展面板搜索 `liaoweipeng1.rtl-hierarchy-explorer`。也可从 GitHub Releases 下载对应已发布版本的 VSIX，通过扩展面板 `…` → **Install from VSIX… / 从 VSIX 安装** 更新，保留原设置。
2. 打开工程文件夹，点击活动栏 **RTL Hierarchy**，使用文件按钮选择 `.f`，使用顶层按钮选择模块。
3. 单击实例跳转实例化位置，右键 **跳转模块定义**；generate 作用域也可定位源码。
4. 面板右上角的结构按钮可切换**精确活动层次 / 静态语法层次**。

找不到按钮时，按 `Ctrl+Shift+P`，输入 `RTL Hierarchy`，即可选择刷新、顶层、文件列表、模式、范围管理和索引日志等命令。

| 日常操作 | 用途 |
|---|---|
| 展开节点 | 查看一个模块下面的子模块实例 |
| 单击实例 | 查看它在上一级中的接线和参数 |
| 右键跳转模块定义 | 查看模块内部实现 |
| 选择顶层 | 聚焦整个工程或某个子模块 |
| 选择 `.f` | 指定当前工程源码，避免历史版本混入 |
| 悬停实例 | 在精确模式中查看求值后的参数 |
| 保存后查看精确树 | 查看当前配置真正启用的实例 |

静态模式可以理解为“源码里写了什么”；精确模式则先代入参数、处理宏开关，再计算本次启用的模块。例如 `CH=4` 的 generate 循环会展开为 4 份实例。宏可用于切换厂商 IP 与行为模型，include 用于读取公共头文件。插件会读取源码和支持的 `.f` 选项，通常不需要重复配置。两种模式都不会运行仿真。

精确后端随包提供 Python 3.13.16 嵌入式运行时、pyslang 12.0.0、nanobind-backend 1.0.0，不要求系统 Python，不下载或安装其它工具，不修改系统 PATH。Windows x64 / Windows 10 1903 及以上可使用精确模式；其它平台使用静态模式。浏览器版、虚拟工作区暂不支持。受限工作区只运行静态 WASM，信任工作区后才启用包内精确后端。

1.0.2 将语法表无损压缩后随包提供，加载时在内存中恢复，不向磁盘展开第二份文件。精确运行库按清单取用，保留完整标准库；运行时仍完全离线。外部显式源文件按父目录补充同步监听，不周期性扫描工程。

## 两种模式

| 项目 | 精确活动层次 | 静态语法层次 |
|---|---|---|
| 预处理 | 应用 include、宏、ifdef/elsif/else | 保留可解析语法，明确标注未求值 |
| 参数和 generate | 求值参数，展开活动 if/case/for、实例数组 | 展示模板及原始参数文本 |
| 同模块不同参数 | 每个实例独立展开 | 共享模块语法定义 |
| 未保存编辑 | 隐藏旧活动树，提示等待保存 | 实时更新编辑文本 |
| 刷新 | 相关源码、头文件、设置变化后重新展开整个工程；空闲时复用缓存 | 按事件只读取、解析变化文件 |
| 错误 | 区分完成、不完整、失败、等待保存，显示后端诊断 | 显示语法恢复、未解析、重名候选 |
| include 导航 | 跳回实际头文件；支持宏展开位置、中文和 UTF-16 列 | 不展开 include |

精确模式只展示模块、接口、程序、primitive/UDP 及包含这些实例的 generate 作用域；纯信号/运算循环不占用层次树。实例 tooltip 显示已求值参数；大型聚合参数只标注已求值，不展开整个值。支持 slang 的 bind、局部定义和配置展开；其中 bind/interface/primitive 已有专项测试，所有 SystemVerilog 特性的组合尚未穷尽测试。

“精确展开完成”表示在**当前源文件、宏、参数与缺省时间单位**下没有后端编译错误，不能替代综合、仿真、时序或板级验收。缺少 IP 定义会显示未解析节点并将工程标为不完整；活动重名定义视为错误。不会静默退回静态模式或把恢复出的部分树当成完整结果。

## 工程范围与配置

使用 `.f` 可以防止历史源码副本混入。每个工程下的“索引范围”显示文件列表、纳入源文件、展开依赖（含 include）及排除项。范围管理按钮可切回扫描或打开设置。多文件夹工程分别索引和展开。

通用工程示例（路径相对当前工作区）：

```json
{
  "rtlHierarchy.analysisMode": "elaborated",
  "rtlHierarchy.fileLists": ["rtl.f"],
  "rtlHierarchy.topModule": "demo_top"
}
```

仓库的 `test/fixtures/project` 提供完全独立的 `demo_top` 和 `leaf` 示例，可直接打开这个文件夹试用。若工程混用有、无 `timescale` 的模块，可按工程要求设置 `rtlHierarchy.defaultTimescale`，例如 `1ns/1ps`；默认留空，插件会显示后端的缺失时间单位诊断。

常用可选设置：

```json
{
  "rtlHierarchy.includeDirectories": ["rtl/include"],
  "rtlHierarchy.defines": ["FEATURE_A", "LANES=4"],
  "rtlHierarchy.parameters": ["LANES=4", "WIDTH=8"],
  "rtlHierarchy.singleUnit": false,
  "rtlHierarchy.fileListBase": "file"
}
```

设置中的宏/参数覆盖 `.f` 中同名值；同名多次赋值取最后一个。`singleUnit` 默认 false，各文件为独立编译单元；启用后按 `.f` 顺序共享预处理宏，`-v` 库文件仍独立。顶层选择按钮保存在工作区状态，优先于 `topModule`；选择“自动发现 / 使用 topModule 设置”可清除手动选择。

没有 `.f` 时按 `include`/`exclude` 扫描，默认匹配 `**/*.{v,sv}`。默认排除 Git、依赖、Quartus 数据库、构建和常见备份目录；自定义 exclude 数组会替换默认数组。排除规则用于编译输入文件，不阻断活动源码语义上需要的 include 依赖。扫描不递归符号链接目录，排除列表最多展示 1000 项。

## `.f` 规则

支持显式 `.v/.sv/.vh/.svh` 路径、引号包裹空格路径、Windows 路径、行/块注释、嵌套 `-f/-F`、`-v file`。精确模式还支持 `+incdir+`、`+define+`、`-I`、`-D`、`-G`、`-top/--top` 和 `--single-unit`。保留 `4'h2` 一类 Verilog 数字字面量中的单引号。

默认所有源文件、include 目录和嵌套列表路径相对**各自所在 `.f` 目录**。`fileListBase: "workspace"` 改为统一相对工作区根目录；不会混用仿真器各自的 `-f/-F` 语义。

暂不导入 QSF，不支持 `-y` 库目录、任意仿真器选项、环境变量展开。列表不支持项或截断范围会阻止精确展开，指定列表失效不会退回全仓库扫描。列表编辑保存后生效；静态模式对宏/include 等选项保留未应用提示。

磁盘源文件/列表按 UTF-8 使用。静态模式可以使用 VS Code 已解码的打开文档；精确模式读取磁盘文件，不使用编辑器的其它编码解码结果。中文路径使用独立 UTF-8 进程宿主，无需修改系统区域设置。

## 性能与故障处理

静态模式保留 0.2 的事件增量、稳定节点 ID、单文件读取和 5000 文件测试。精确模式相关文件保存后进行全工程重新展开，不能宣称只重新编译受影响文件；原生文件 I/O 也不计入静态读取计数。include 依赖和外部源文件会被监听，手动刷新可恢复漏报事件。

每次精确后端运行上限 30 秒，模块深度 128、单个 generate/实例数组 16384、转换符号 200000、显示节点 100000、输出 256 MiB。达到限制会报错，不悄悄截断成成功结果。工作线程请求上限 120 秒；超时/退出会中止子进程，下一次刷新重建后端。默认最多 5000 个编译输入文件、单文件 8 MiB；include 加载由编译器管理，受进程超时和层次限制约束。

只提取层次符号，不使用通用完整 AST 导出，避免序列化 RAM 和大量表达式。临时数据使用宿主临时目录，正常结束后清理。

## 开发与验证

完整构建与精确后端测试需要 Windows x64、Node.js 22 或更高版本。仓库包含已固定哈希的第三方离线资源；开发依赖通过 npm 安装。下列命令从仓库根目录执行：

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run package
```

真实 VS Code 宿主测试复用本机编辑器：先将 `VSCODE_EXECUTABLE_PATH` 环境变量设置为本机 `Code.exe` 的绝对路径，再运行 `npm.cmd run test:host`。未设置时命令会说明原因并退出，不会自动下载安装 VS Code。测试的用户数据、临时工作区和日志位于仓库内被 Git 忽略的目录。`npm.cmd run test:stress` 使用自动生成的 5000 个小型模块验证静态增量刷新。

构建依赖固定在 package-lock.json；第三方运行时来源和哈希见 `vendor/runtime-provenance.json` 与 `vendor/slang-runtime-manifest.json`。`scripts/prepare-python-host.py` 从原版 python.exe 复制生成只修改进程 manifest 的 rtl-python.exe，保留原解释器；其作用是让 Windows 原生路径接口使用 UTF-8，生成文件不是 Python 官方原始签名二进制。运行时以隔离模式禁用用户 site、环境 Python 路径和字节码写入，不导入工作区 Python 代码。

主要实现：`src/elaboration.ts` 管理后端/缓存/错误与树转换，`src/slang_bridge.py` 只导出层次，`src/parser.ts` 保留 Tree-sitter 静态提取，`src/project.ts` 管理工程范围，`src/extension.ts` 提供界面、监听和导航。

本地回归套件包含 38 项独立样例自动测试和真实 VS Code 宿主的 16 项检查，含宏、generate、参数不同的实例、升降序/多维数组、bind/interface/primitive、中文/宏/include 导航、重复定义、缺失 IP、超时恢复、未保存等待、外部头文件、双工作区隔离、外部文件首次显示后的立即编辑，以及压缩资源和运行库清单一致性。

测试样例用于验证解析和浏览行为，不依赖产品工程。测试结果是层次工具验证，不是 RTL 功能仿真或综合结果。提交问题时请提供可公开的最小样例，详见 [使用帮助](SUPPORT.md)。

## 许可证

原创代码采用 [MIT 许可证](LICENSE)，Copyright (c) 2026 liaoweipeng1。允许按许可证使用、修改和分发；第三方组件保留各自的版权与条款，详见 [第三方组件说明](THIRD_PARTY_NOTICES.md)。

技术来源：[slang](https://github.com/MikePopoloski/slang)、[pyslang 12.0](https://pypi.org/project/pyslang/12.0.0/)、[Tree-sitter SystemVerilog](https://github.com/gmlarumbe/tree-sitter-systemverilog)、[VS Code Tree View](https://code.visualstudio.com/api/extension-guides/tree-view)。
