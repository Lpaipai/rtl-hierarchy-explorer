# 第三方组件说明

本项目原创实现采用根目录 LICENSE 中的 MIT 许可证，版权署名为 liaoweipeng1。未复制 VeTree 源码。第三方组件保留各自的版权及许可证，项目的 MIT 许可不替代第三方条款。

以下组件按照其 MIT 许可证使用，完整许可证副本随 VSIX 放在 `dist/licenses/`：

| 组件 | 版本 | 用途 | 来源 |
|---|---|---|---|
| tree-sitter-systemverilog | 0.4.1 | SystemVerilog 语法 WASM | https://github.com/gmlarumbe/tree-sitter-systemverilog |
| web-tree-sitter | 0.25.10 | Tree-sitter JavaScript/WASM 运行时 | https://github.com/tree-sitter/tree-sitter |
| picomatch | 4.0.3 | 文件范围匹配 | https://github.com/micromatch/picomatch |

语法 WASM 直接来自官方 v0.4.1 release，未修改；源码仓库的许可证副本在 `vendor/licenses/tree-sitter-systemverilog.txt`：

- 下载：`https://github.com/gmlarumbe/tree-sitter-systemverilog/releases/download/v0.4.1/tree-sitter-systemverilog.wasm`
- 大小：23,483,181 字节。
- SHA-256：`1d7315a7b71772b0c2834e1e9b5444af72807aca3f200159cd5e7ef77acb17d8`，与官方 release asset digest 一致；构建时再次检查。

自 1.0.2 起，VSIX 内以 Brotli 无损压缩格式存放，运行时在内存中恢复上述原始字节；vendor 中的原件与许可证不变。

TypeScript、esbuild、VS Code 类型及测试/打包工具仅用于开发；未作为运行时依赖完整打包进 VSIX。实际依赖版本及传递依赖完整性见 `package-lock.json`。

## 精确后端（自 0.3.0 起，1.0.0 沿用）

| 组件 | 版本 | 许可证及包内位置 | 官方来源 |
|---|---|---|---|
| Python Windows 嵌入式运行时 | 3.13.16 x64 | PSF 及组件许可，`dist/slang-runtime/LICENSE.txt` | https://www.python.org/downloads/release/python-31316/ |
| pyslang | 12.0.0 | MIT，`dist/slang-runtime/pyslang-12.0.0.dist-info/licenses/LICENSE` | https://pypi.org/project/pyslang/12.0.0/ |
| nanobind-backend | 1.0.0 cp313 x64 | BSD，`dist/slang-runtime/nanobind-LICENSE.txt` | https://pypi.org/project/nanobind-backend/1.0.0/ |

下载归档按官方网站/PyPI 的 SHA-256 核对，精确来源见 vendor/runtime-provenance.json。第三方 Python 模块和 DLL 保持发布包内容，构建时及后端首次运行时按固定文件清单检查。

自 1.0.2 起，`vendor/slang-runtime-manifest.json` 是实际打包的文件白名单。完整标准库 `python313.zip` 保留；不打包未使用的扩展模块、类型声明、辅助启动器及一份重复的 MSVC DLL。桥接器先导入 pyslang，其原有初始化代码注册 `pyslang.libs` 搜索目录，再加载 nanobind 后端；两者共用该目录中相同文件名及 SHA-256 的 DLL。vendor 中的第三方原件完整保留，未改写其代码或二进制。

原版 `python.exe` 保留不变。`rtl-python.exe` 是项目从原版复制后仅加入 `activeCodePage=UTF-8` manifest 的衍生文件，用于 Windows 中文路径；不是官方原始签名二进制。修改脚本为 scripts/prepare-python-host.py，遵循 Python 许可并保留全部版权声明。无系统配置变更。项目自有 slang_bridge.py 通过公开 API 导出必要层次，不复制 slang 编译器实现。
