import * as vscode from 'vscode';

/**
 * 根据 uri 字符串与原始本地路径生成目标 URI。
 * 本地 file 场景优先用 fsPath 构造，避免 Uri.parse 对 UNC 路径的规范化差异，
 * 保证与活动编辑器 uri 的 fsPath 一致，让同文件跳转判断更可靠。
 */
export function resolveTargetUri(uriString: string | undefined, legacyPath: string): vscode.Uri {
  if (uriString && uriString.startsWith('file://')) {
    if (legacyPath) {
      return vscode.Uri.file(legacyPath);
    }
    return vscode.Uri.parse(uriString, true);
  }
  if (uriString) {
    return vscode.Uri.parse(uriString, true);
  }
  return vscode.Uri.file(legacyPath);
}
