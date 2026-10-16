# 2026/10/16 17:54:00 by liaoweipeng1
"""仅导出层次符号；不序列化语句、表达式和 RAM 初值。"""
import json
import sys
from pathlib import Path

import pyslang
from pyslang.driver import CommandLineOptions, Driver


def main():
    command_file, output_directory = sys.argv[1:]
    output = Path(output_directory)
    driver = Driver()
    driver.addStandardArgs()
    driver.setTerminalColorsEnabled(False)
    options = CommandLineOptions()
    options.expandEnvVars = False
    options.ignoreProgramName = True
    if not driver.parseCommandLine(Path(command_file).read_text(encoding="utf-8"), options) or not driver.processOptions():
        raise RuntimeError(driver.textDiagClient.getString() or "slang 编译选项无效")
    if not driver.parseAllSources():
        raise RuntimeError(driver.textDiagClient.getString() or "slang 无法加载源文件")
    compilation = driver.createCompilation()
    root = compilation.getRoot()
    diagnostics = compilation.getAllDiagnostics()
    manager = driver.sourceManager
    engine = driver.diagEngine
    engine.setMappingsFromPragmas()
    source_text = {}

    def location(loc):
        if not loc:
            return {}
        loc = manager.getFullyExpandedLoc(loc)
        filename = str(manager.getFullPath(loc.buffer))
        if not filename or filename == ".":
            return {}
        # Physical buffer offsets avoid treating a `line directive as an actual file path.
        if loc.buffer not in source_text:
            source_text[loc.buffer] = manager.getSourceText(loc.buffer).encode("utf-8")
        text = source_text[loc.buffer]
        prefix = text[:loc.offset]
        current_line = prefix.rsplit(b"\n", 1)[-1].decode("utf-8")
        if b"\n" not in prefix:
            current_line = current_line.removeprefix("\ufeff")
        return {
            "source_file": filename,
            "source_line": prefix.count(b"\n") + 1,
            "source_column": len(prefix.rsplit(b"\n", 1)[-1]) + 1,
            "utf16_column": len(current_line.encode("utf-16-le")) // 2,
        }

    def base(symbol):
        return {"kind": symbol.kind.name, "name": symbol.name, **location(symbol.location)}

    count = 0

    def convert(symbol, depth=0):
        nonlocal count
        kind = symbol.kind.name
        supported = {"Instance", "InstanceBody", "GenerateBlock", "GenerateBlockArray", "InstanceArray",
                     "UninstantiatedDef", "PrimitiveInstance", "Parameter", "TypeParameter"}
        if kind not in supported or getattr(symbol, "isUninstantiated", False):
            return None
        if kind in {"Parameter", "TypeParameter"} and symbol.isLocalParam:
            return None
        count += 1
        if count > 200_000 or depth > 300:
            raise RuntimeError("层次符号数量或深度超过限制")
        result = {"kind": kind, "name": symbol.name}
        if kind == "Instance":
            result["body"] = convert(symbol.body, depth + 1)
        elif kind == "Parameter":
            result["isLocal"] = symbol.isLocalParam
            value = symbol.value
            result["value"] = "<聚合参数，已求值，省略显示>" if value.isContainer() else str(value)
        elif kind == "TypeParameter":
            result["isLocal"] = symbol.isLocalParam
            result["targetType"] = str(symbol.typeAlias)
        elif kind == "UninstantiatedDef":
            result["definitionName"] = symbol.definitionName
        elif kind == "PrimitiveInstance":
            result["primitiveType"] = "0 " + symbol.primitiveType.name
        else:
            if kind == "InstanceArray":
                result["range"] = f"[{symbol.range.left}:{symbol.range.right}]"
            if kind in {"GenerateBlock", "GenerateBlockArray"}:
                result["constructIndex"] = symbol.constructIndex
                result["name"] = symbol.name or symbol.externalName
            if kind == "GenerateBlockArray":
                result["loopVariable"] = "0 " + symbol.loopVariable.name
            if kind == "InstanceBody":
                result["definition"] = base(symbol.definition)
            result["members"] = [child for member in symbol if (child := convert(member, depth + 1)) is not None]
            if kind in {"GenerateBlock", "GenerateBlockArray"} and not result["members"]:
                return None
            if kind == "GenerateBlockArray":
                active = [entry for entry in symbol.entries if not entry.isUninstantiated]
                by_index = {entry.constructIndex: entry for entry in active}
                for child in result["members"]:
                    child["arrayIndex"] = str(by_index[child["constructIndex"]].arrayIndex)
        result.update(location(symbol.location))
        return result

    definitions = []
    for definition in compilation.getDefinitions():
        item = base(definition)
        item["definitionKind"] = getattr(getattr(definition, "definitionKind", None), "name", "module")
        definitions.append(item)
    design = {"design": {"kind": "Root", "members": [convert(instance) for instance in root.topInstances]},
              "definitions": definitions}
    reported = []
    for diagnostic in diagnostics:
        severity = engine.getSeverity(diagnostic.code, diagnostic.location).name.lower()
        if severity in {"ignored", "note"}:
            continue
        loc = location(diagnostic.location)
        position = f"{loc['source_file']}:{loc['source_line']}:{loc['source_column']}" if loc else ""
        reported.append({"code": str(diagnostic.code), "severity": severity, "location": position,
                         "message": engine.formatMessage(diagnostic), **loc})
    dependencies = set()
    for buffer in manager.getAllBuffers():
        filename = str(manager.getFullPath(buffer))
        if filename and filename != ".":
            dependencies.add(filename)
    (output / "design.json").write_text(json.dumps(design, ensure_ascii=False), encoding="utf-8")
    (output / "diagnostics.json").write_text(json.dumps(reported, ensure_ascii=False), encoding="utf-8")
    (output / "dependencies.f").write_text("\n".join(sorted(dependencies)), encoding="utf-8")
    return int(any(item["severity"] in {"error", "fatal"} for item in reported))


if __name__ == "__main__":
    sys.exit(main())
