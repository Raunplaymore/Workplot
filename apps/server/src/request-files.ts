import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RequestFiles } from '@studio/contracts';

export class AttachmentError extends Error {}
export type Reference = { name: string; text?: string; image?: string };
const ignored = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
]);
const imageExt = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const textExt = new Set([
  '.md',
  '.txt',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.html',
  '.xml',
  '.py',
  '.sql',
  '.toml',
  '.log',
]);
function hidden(name: string) {
  return (
    name.startsWith('.') ||
    ignored.has(name) ||
    /^(id_rsa|id_ed25519|credentials\.json|secrets?\.json)$/i.test(name)
  );
}
async function canonical(input: string) {
  const value = input.startsWith('~/')
    ? join(homedir(), input.slice(2))
    : input;
  if (
    !isAbsolute(value) ||
    value.split(sep).some((n) => n === '..' || hidden(n))
  )
    throw new AttachmentError('숨김 경로를 제외한 절대 경로를 입력하세요.');
  const path = await realpath(value);
  if (
    path.split(sep).some(hidden) ||
    path === homedir() ||
    relative(path, homedir()).split(sep)[0] !== '..' ||
    (await lstat(value)).isSymbolicLink()
  )
    throw new AttachmentError('개별 파일이나 작업용 하위 폴더를 선택하세요.');
  return path;
}
export async function checkWorkspace(path: string) {
  if ((await canonical(path)) !== path || !(await lstat(path)).isDirectory())
    throw new AttachmentError('수정할 작업 폴더를 확인하세요.');
  return path;
}
export async function snapshotFiles(input: RequestFiles) {
  try {
    const workspace = input.workspace
      ? await checkWorkspace(await canonical(input.workspace))
      : undefined;
    const refs: Reference[] = [];
    const seen = new Set<string>();
    let bytes = 0,
      entries = 0;
    async function visit(path: string, label: string, selected: boolean) {
      if (++entries > 1500)
        throw new AttachmentError('더 작은 참고 폴더를 선택하세요.');
      if ((await realpath(path)) !== path)
        throw new AttachmentError('연결된 경로는 첨부할 수 없습니다.');
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        const dir = await opendir(path);
        for await (const item of dir)
          if (
            !hidden(item.name) &&
            !item.isSymbolicLink() &&
            (item.isDirectory() || item.isFile())
          )
            await visit(join(path, item.name), label + '/' + item.name, false);
        return;
      }
      const ext = extname(path).toLowerCase(),
        image = imageExt.has(ext);
      if (!stat.isFile() || (!image && !textExt.has(ext))) {
        if (selected)
          throw new AttachmentError(
            '텍스트·소스 파일 또는 PNG·JPEG·WebP를 선택하세요.',
          );
        return;
      }
      if (seen.has(path)) return;
      seen.add(path);
      if (
        refs.length >= 32 ||
        stat.size > (image ? 4_000_000 : 100_000) ||
        (bytes += stat.size) > 8_000_000
      )
        throw new AttachmentError(
          '첨부는 최대 32개·총 8MB이며 문서당 100KB, 이미지당 4MB까지 지원합니다.',
        );
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await file.stat();
        if (
          !opened.isFile() ||
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev ||
          opened.size !== stat.size
        )
          throw new AttachmentError('파일이 변경됐습니다. 다시 첨부하세요.');
        const data = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await file.read(
            data,
            offset,
            data.length - offset,
            null,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== stat.size)
          throw new AttachmentError('첨부 크기가 변경됐습니다.');
        const content = data.subarray(0, offset);
        refs.push(
          image
            ? { name: label, image: content.toString('base64') }
            : {
                name: label,
                text: new TextDecoder('utf-8', { fatal: true }).decode(content),
              },
        );
      } finally {
        await file.close();
      }
    }
    for (const name of input.references) {
      const path = await canonical(name);
      if (
        workspace &&
        (path === workspace ||
          path.startsWith(workspace + sep) ||
          workspace.startsWith(path + sep))
      )
        throw new AttachmentError(
          '참고 자료와 수정할 작업 폴더는 서로 겹치지 않게 지정하세요.',
        );
      await visit(path, basename(path), true);
    }
    if (input.references.length && !refs.length)
      throw new AttachmentError('선택한 경로에 지원하는 참고 파일이 없습니다.');
    if (refs.reduce((n, f) => n + (f.text?.length ?? 0), 0) > 120000)
      throw new AttachmentError('참고 문서의 합계가 12만 자를 넘습니다.');
    return { workspace, refs };
  } catch (e) {
    if (e instanceof AttachmentError) throw e;
    throw new AttachmentError(
      '경로, 읽기 권한 및 파일 인코딩(UTF-8)을 확인하세요.',
    );
  }
}
export async function choosePath(kind: 'file' | 'folder') {
  const expression = kind === 'file' ? 'choose file' : 'choose folder';
  try {
    return (
      await promisify(execFile)(
        'osascript',
        ['-e', 'POSIX path of (' + expression + ')'],
        { timeout: 120000 },
      )
    ).stdout.trim();
  } catch (e) {
    if (String(e).includes('(-128)')) return '';
    throw new AttachmentError(
      '선택 창을 열지 못했습니다. 경로를 직접 입력하세요.',
    );
  }
}
