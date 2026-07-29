import {
  mkdir,
  mkdtemp,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findRelativePathCollisions,
  isSameOrDescendantPath,
  normalizeSafeRelativePath,
  PathSafetyError,
  resolveSafeDestination,
  UnsafeRelativePathError,
  validateInputOutputSeparation
} from '../src/main/core/path-safety'

describe('normalizeSafeRelativePath', () => {
  it('保留 Unicode 名称并规范分隔符与当前目录段', () => {
    expect(normalizeSafeRelativePath('./产品图\\人物/主图 01.jpg')).toBe(
      '产品图/人物/主图 01.jpg'
    )
  })

  it.each([
    '/etc/passwd',
    '\\\\server\\share\\a.jpg',
    'C:\\Windows\\a.jpg',
    '../escape.jpg',
    'safe/../../escape.jpg',
    'safe/file.jpg:secret',
    'safe/NUL.txt',
    'safe/trailing. ',
    'safe/a?.jpg',
    'safe/\u0000.jpg'
  ])('拒绝危险或跨平台不可写路径：%s', (unsafePath) => {
    expect(() => normalizeSafeRelativePath(unsafePath)).toThrow(
      UnsafeRelativePathError
    )
  })

  it('只解析到给定根目录内', () => {
    const root = '/tmp/archive-root'
    const destination = resolveSafeDestination(root, '图集/正面.jpg')
    expect(isSameOrDescendantPath(root, destination, 'linux')).toBe(true)
  })

  it('以大小写和 Unicode 规范等价检测输出冲突', () => {
    const collisions = findRelativePathCollisions([
      '来源/Café.jpg',
      '来源/CAFE\u0301.JPG',
      '来源/不同.jpg',
      '来源/σ.png',
      '来源/ς.PNG',
      '来源/ß.webp',
      '来源/ss.WEBP',
      '来源/ﬀ.gif',
      '来源/ff.GIF'
    ])
    expect(collisions).toHaveLength(4)
    expect(collisions.map(({ paths }) => paths.length)).toEqual([2, 2, 2, 2])
  })
})

describe('validateInputOutputSeparation', () => {
  it('拒绝输出位于输入目录内或输入目录位于输出内', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-path-'))
    const input = join(root, 'input')
    const nestedOutput = join(input, 'results')
    const outerOutput = join(root, 'outer')
    const nestedInput = join(outerOutput, 'incoming')
    await mkdir(input, { recursive: true })
    await mkdir(nestedOutput, { recursive: true })
    await mkdir(nestedInput, { recursive: true })

    expect(() =>
      validateInputOutputSeparation(
        [{ path: input, kind: 'folder' }],
        nestedOutput
      )
    ).toThrow(PathSafetyError)
    expect(() =>
      validateInputOutputSeparation(
        [{ path: nestedInput, kind: 'folder' }],
        outerOutput
      )
    ).toThrow(PathSafetyError)
  })

  it('允许普通文件的输出目录位于文件旁边', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-file-path-'))
    const inputFile = join(root, 'source.jpg')
    const output = join(root, 'output')
    await writeFile(inputFile, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    await mkdir(output)

    expect(() =>
      validateInputOutputSeparation(
        [{ path: inputFile, kind: 'file' }],
        output
      )
    ).not.toThrow()
  })
})
