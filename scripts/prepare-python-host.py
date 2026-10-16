# 2026/10/16 18:00:00 by liaoweipeng1
"""为项目内的 Python 副本添加 UTF-8 进程 manifest；不修改原版解释器。"""
import ctypes
import shutil
from pathlib import Path


root = Path(__file__).resolve().parent.parent
runtime = root / "vendor" / "slang-runtime"
source = runtime / "python.exe"
target = runtime / "rtl-python.exe"
if not target.resolve().is_relative_to(root):
    raise RuntimeError("仅允许写入项目内的运行时副本")
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint32]
kernel.LoadLibraryExW.restype = ctypes.c_void_p
kernel.FindResourceW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
kernel.FindResourceW.restype = ctypes.c_void_p
kernel.LoadResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
kernel.LoadResource.restype = ctypes.c_void_p
kernel.LockResource.argtypes = [ctypes.c_void_p]
kernel.LockResource.restype = ctypes.c_void_p
kernel.SizeofResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
kernel.SizeofResource.restype = ctypes.c_uint32
kernel.FreeLibrary.argtypes = [ctypes.c_void_p]
kernel.BeginUpdateResourceW.argtypes = [ctypes.c_wchar_p, ctypes.c_bool]
kernel.BeginUpdateResourceW.restype = ctypes.c_void_p
kernel.UpdateResourceW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                 ctypes.c_uint16, ctypes.c_void_p, ctypes.c_uint32]
kernel.EndUpdateResourceW.argtypes = [ctypes.c_void_p, ctypes.c_bool]

module = kernel.LoadLibraryExW(str(source), None, 2)
resource = kernel.FindResourceW(module, 1, 24)
if not module or not resource:
    raise ctypes.WinError(ctypes.get_last_error())
size = kernel.SizeofResource(module, resource)
pointer = kernel.LockResource(kernel.LoadResource(module, resource))
manifest = ctypes.string_at(pointer, size).decode("utf-8")
kernel.FreeLibrary(module)
if "activeCodePage" in manifest:
    raise RuntimeError("原版已含 activeCodePage，请检查 manifest 后再更新脚本")
addition = '<activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>'
if "</windowsSettings>" not in manifest:
    raise RuntimeError("未找到预期的 windowsSettings 节点")
manifest = manifest.replace("</windowsSettings>", addition + "</windowsSettings>").encode("utf-8")
shutil.copy2(source, target)
handle = kernel.BeginUpdateResourceW(str(target), False)
if not handle:
    raise ctypes.WinError(ctypes.get_last_error())
if not kernel.UpdateResourceW(handle, 24, 1, 1033, manifest, len(manifest)):
    kernel.EndUpdateResourceW(handle, True)
    raise ctypes.WinError(ctypes.get_last_error())
if not kernel.EndUpdateResourceW(handle, False):
    raise ctypes.WinError(ctypes.get_last_error())
print(f"已生成仅进程启用 UTF-8 的解释器副本：{target}")
