export const DEFAULT_REMOTE_PORT = 22;
export const REMOTE_HOME_ROOT = '/home';

export const DEFAULT_INCLUDE_GLOBS: string[] = [];

// 定义搜索（含右键“转到定义”）默认排除的路径：文件名/目录名含 mock 的文件
// 属于单元测试相关产物，不作为定义跳转目标。需要额外排除时由用户补充配置。
export const DEFAULT_DEFINITION_EXCLUDE_GLOBS: string[] = [
  '**/*mock*',
  '**/*mock*/**'
];

export const DEFAULT_EXCLUDE_GLOBS = [
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.*/**',
  '**/node_modules/**',
  '**/.cache/**',
  '**/__pycache__/**',
  '**/.gradle/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.vs/**',
  '**/.settings/**',
  '**/.DS_Store',
  '**/*.7z',
  '**/*.a',
  '**/*.apk',
  '**/*.bin',
  '**/*.bz2',
  '**/*.class',
  '**/*.dll',
  '**/*.dmg',
  '**/*.ear',
  '**/*.exe',
  '**/*.gz',
  '**/*.ico',
  '**/*.jar',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.lib',
  '**/*.min.js.map',
  '**/*.min.css.map',
  '**/*.mp3',
  '**/*.mp4',
  '**/*.o',
  '**/*.obj',
  '**/*.otf',
  '**/*.pdf',
  '**/*.pdb',
  '**/*.png',
  '**/*.pyc',
  '**/*.rar',
  '**/*.so',
  '**/*.svgz',
  '**/*.tar',
  '**/*.tgz',
  '**/*.ttf',
  '**/*.war',
  '**/*.webp',
  '**/*.woff',
  '**/*.woff2',
  '**/*.xz',
  '**/*.zip'
];
