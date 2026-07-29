import { describe, expect, it } from 'vitest'
import {
  allocateFlatOutputNames,
  allocateSourceAwareOutputPaths
} from '../src/main/core/output-names'
import { portableRelativePathKey } from '../src/main/core/path-safety'

function values(files: Array<{ id: string; relativePath: string }>): string[] {
  return [...allocateFlatOutputNames(files).values()]
}

describe('flat output name allocation', () => {
  it('flattens nested paths while preserving unique basenames', () => {
    expect(
      values([
        { id: 'one', relativePath: '商品 A/主图.jpg' },
        { id: 'two', relativePath: '商品 B/细节图.png' }
      ])
    ).toEqual(['主图.jpg', '细节图.png'])
  })

  it('handles case, Unicode and naturally numbered name collisions', () => {
    const allocated = values([
      { id: 'one', relativePath: 'a.jpg' },
      { id: 'two', relativePath: 'A.JPG' },
      { id: 'three', relativePath: 'a (2).jpg' },
      { id: 'four', relativePath: 'Café.png' },
      { id: 'five', relativePath: 'CAFE\u0301.PNG' }
    ])
    const keys = allocated.map(portableRelativePathKey)

    expect(allocated).toEqual([
      'a.jpg',
      'A (3).JPG',
      'a (2).jpg',
      'Café.png',
      'CAFE\u0301 (2).PNG'
    ])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('handles filesystem case-fold equivalents beyond lowercase', () => {
    const allocated = values([
      { id: 'sigma', relativePath: 'σ.jpg' },
      { id: 'final-sigma', relativePath: 'ς.jpg' },
      { id: 'sharp-s', relativePath: 'ß.png' },
      { id: 'double-s', relativePath: 'ss.png' },
      { id: 'ligature', relativePath: 'ﬀ.webp' },
      { id: 'letters', relativePath: 'ff.webp' }
    ])

    expect(allocated).toEqual([
      'σ.jpg',
      'ς (2).jpg',
      'ß.png',
      'ss (2).png',
      'ﬀ.webp',
      'ff (2).webp'
    ])
    expect(
      new Set(allocated.map(portableRelativePathKey)).size
    ).toBe(allocated.length)
  })

  it('rejects duplicate file IDs instead of silently reusing an output name', () => {
    expect(() =>
      allocateFlatOutputNames([
        { id: 'same', relativePath: 'one.jpg' },
        { id: 'same', relativePath: 'two.jpg' }
      ])
    ).toThrow(/输入文件标识重复/)
  })

  it('allocates ten thousand duplicates without quadratic suffix rescans', () => {
    const allocated = values(
      Array.from({ length: 10_000 }, (_, index) => ({
        id: String(index),
        relativePath: '同名图片.jpg'
      }))
    )

    expect(allocated).toHaveLength(10_000)
    expect(allocated[0]).toBe('同名图片.jpg')
    expect(allocated.at(-1)).toBe('同名图片 (10000).jpg')
    expect(
      new Set(allocated.map(portableRelativePathKey)).size
    ).toBe(allocated.length)
  })

  it('keeps collision names within a conservative cross-platform limit', () => {
    const longName = `${'图'.repeat(80)}.jpg`
    const allocated = values([
      { id: 'one', relativePath: longName },
      { id: 'two', relativePath: longName }
    ])
    const duplicate = allocated[1]!

    expect(allocated[0]).toBe(longName)
    expect(duplicate).toMatch(/ \(2\)\.jpg$/)
    expect(Buffer.byteLength(duplicate, 'utf8')).toBeLessThanOrEqual(240)
    expect(duplicate.length).toBeLessThanOrEqual(240)
  })
})

describe('source-aware output path allocation', () => {
  it('keeps same-named files in separate folder-input namespaces', () => {
    const allocated = allocateSourceAwareOutputPaths([
      {
        id: 'first-file',
        sourceId: 'first-folder',
        sourceDirectoryName: '牛油果收纳盒',
        relativePath: '主图.jpg'
      },
      {
        id: 'second-file',
        sourceId: 'second-folder',
        sourceDirectoryName: '沙拉罐图片',
        relativePath: '主图.jpg'
      }
    ])

    expect([...allocated.values()]).toEqual([
      '牛油果收纳盒/主图.jpg',
      '沙拉罐图片/主图.jpg'
    ])
  })

  it('gives portable-equivalent folder names unique directories', () => {
    const allocated = allocateSourceAwareOutputPaths([
      {
        id: 'first',
        sourceId: 'first-folder',
        sourceDirectoryName: '商品图',
        relativePath: '主图.jpg'
      },
      {
        id: 'second',
        sourceId: 'second-folder',
        sourceDirectoryName: '商品图',
        relativePath: '主图.jpg'
      },
      {
        id: 'natural',
        sourceId: 'natural-folder',
        sourceDirectoryName: '商品图 (2)',
        relativePath: '主图.jpg'
      }
    ])

    expect([...allocated.values()]).toEqual([
      '商品图/主图.jpg',
      '商品图 (3)/主图.jpg',
      '商品图 (2)/主图.jpg'
    ])
  })
})
