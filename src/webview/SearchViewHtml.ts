import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { DEFAULT_EXCLUDE_GLOBS, DEFAULT_INCLUDE_GLOBS, DEFAULT_REMOTE_PORT } from '../core/defaults';

export type SearchViewHtmlPaths = {
  html: string;
  css: string;
  js: string;
  resultsRendererJs: string;
  searchHistoryJs: string;
  settingsPanelJs: string;
  iconsJs: string;
};

export async function renderSearchViewHtml(
  context: vscode.ExtensionContext,
  webviewView: vscode.WebviewView,
  paths: SearchViewHtmlPaths,
  nonce: string,
  iconUris: Record<string, unknown>
): Promise<string> {
  const htmlTemplate = await fs.readFile(context.asAbsolutePath(paths.html), 'utf8');
  const cssUri = webviewView.webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(paths.css)));
  const resultsRendererJsUri = webviewView.webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(paths.resultsRendererJs)));
  const searchHistoryJsUri = webviewView.webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(paths.searchHistoryJs)));
  const settingsPanelJsUri = webviewView.webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(paths.settingsPanelJs)));
  const iconsJsUri = webviewView.webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(paths.iconsJs)));
  const jsUri = webviewView.webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(paths.js)));
  const csp = [
    `default-src 'none'`,
    `img-src ${webviewView.webview.cspSource} data:`,
    `style-src ${webviewView.webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${webviewView.webview.cspSource}`
  ].join('; ');

  return htmlTemplate
    .split('__CSP__').join(csp)
    .split('__NONCE__').join(nonce)
    .split('__CSS_URI__').join(cssUri.toString())
    .split('__RESULTS_RENDERER_JS_URI__').join(resultsRendererJsUri.toString())
    .split('__SEARCH_HISTORY_JS_URI__').join(searchHistoryJsUri.toString())
    .split('__SETTINGS_PANEL_JS_URI__').join(settingsPanelJsUri.toString())
    .split('__ICONS_JS_URI__').join(iconsJsUri.toString())
    .split('__JS_URI__').join(jsUri.toString())
    .split('__EXTENSION_VERSION__').join(JSON.stringify(context.extension.packageJSON.version ?? 'unknown'))
    .split('__DEFAULT_REMOTE_PORT__').join(String(DEFAULT_REMOTE_PORT))
    .split('__DEFAULT_INCLUDE_GLOBS__').join(JSON.stringify(DEFAULT_INCLUDE_GLOBS))
    .split('__DEFAULT_EXCLUDE_GLOBS__').join(JSON.stringify(DEFAULT_EXCLUDE_GLOBS))
    .split('__ICON_URIS__').join(JSON.stringify(iconUris));
}

export function renderFallbackHtml(message: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="UTF-8" /></head>',
    '<body>',
    `<p>${message}</p>`,
    '</body>',
    '</html>'
  ].join('');
}

export function buildIconUris(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  codiconPaths: Record<string, string>,
  fileTypePaths: Record<string, string>
): Record<string, unknown> {
  const codicons = Object.fromEntries(
    Object.entries(codiconPaths).map(([key, relativePath]) => [
      key,
      webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(relativePath))).toString()
    ])
  );

  const fileTypes = Object.fromEntries(
    Object.entries(fileTypePaths).map(([key, relativePath]) => [
      key,
      webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath(relativePath))).toString()
    ])
  );

  return {
    ...codicons,
    fileTypes,
    codiconSvg: codicons
  };
}
