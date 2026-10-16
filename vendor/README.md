# 第三方离线资源

本目录提供构建所需的固定版本资源，克隆仓库后无需另外安装系统 Python 或下载解析器。

- `tree-sitter-systemverilog.wasm`：官方 0.4.1 发布资源，MIT 许可证副本位于 `licenses/tree-sitter-systemverilog.txt`。
- `slang-runtime/`：Python 3.13.16 x64、pyslang 12.0.0、nanobind-backend 1.0.0 及其许可证。各组件沿用各自的许可证。
- `runtime-provenance.json`：官方下载地址、归档哈希和 UTF-8 宿主的生成说明。
- `slang-runtime-manifest.json`：构建和运行时校验的文件 SHA-256 清单。

`rtl-python.exe` 从保留的原版 `python.exe` 复制，只增加 Windows UTF-8 进程 manifest。使用 `scripts/prepare-python-host.py` 可重新生成这个副本；需要 Windows。派生副本不是 Python 官方原始签名二进制。

运行 `npm run build` 会校验资源哈希后复制所需资源到安装包。详细来源和许可证见根目录 `THIRD_PARTY_NOTICES.md`。
