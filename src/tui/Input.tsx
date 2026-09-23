import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { CompletionRequest } from './completion.ts'

// 多行输入（自实现）：Enter 提交 / Shift+Enter 换行 / ←→ 移动光标 /
// ↑↓ 单行翻历史·多行行间移动 / Backspace·Delete 删除 / 光标反色块显示
export function Input({
  onSend,
  onTabComplete,
  disabled,
  placeholder,
  menuOpen,
  completionRequest,
  onCompletionApplied,
  onEditingChange,
}: {
  onSend: (value: string) => void
  onTabComplete: (value: string) => string | null
  disabled: boolean
  placeholder?: string
  menuOpen?: boolean // 补全菜单打开时禁用 ↑↓ 历史导航（菜单用 ↑↓ 选择）
  completionRequest?: CompletionRequest | null
  onCompletionApplied?: () => void
  onEditingChange?: (editing: boolean) => void
}) {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const historyRef = useRef<string[]>([])
  const histIdxRef = useRef(-1)
  const editingRef = useRef(false)
  const multiline = value.includes('\n')

  useEffect(() => {
    return () => {
      if (editingRef.current) onEditingChange?.(false)
    }
  }, [onEditingChange])

  const updateValue = (next: string): void => {
    const editing = next.length > 0
    if (editing !== editingRef.current) {
      editingRef.current = editing
      onEditingChange?.(editing)
    }
    setValue(next)
  }

  useEffect(() => {
    if (!completionRequest) return
    updateValue(completionRequest.value)
    setCursor(completionRequest.value.length)
    histIdxRef.current = -1
    onCompletionApplied?.()
  }, [completionRequest])

  const insert = (ch: string): void => {
    updateValue(value.slice(0, cursor) + ch + value.slice(cursor))
    setCursor((c) => c + ch.length)
  }
  const backspace = (): void => {
    if (cursor <= 0) return
    updateValue(value.slice(0, cursor - 1) + value.slice(cursor))
    setCursor((c) => c - 1)
  }
  const del = (): void => {
    if (cursor >= value.length) return
    updateValue(value.slice(0, cursor) + value.slice(cursor + 1))
  }
  // 行间移动（按 \n 分段；目标行同列偏移，越界收敛到行尾）
  const moveLine = (dir: number): void => {
    const lines = value.split('\n')
    let lineIdx = 0
    let offset = cursor
    for (let i = 0; i < lines.length; i++) {
      if (offset <= lines[i].length) {
        lineIdx = i
        break
      }
      offset -= lines[i].length + 1
    }
    const target = lineIdx + dir
    if (target < 0 || target >= lines.length) return
    const newOffset = Math.min(offset, lines[target].length)
    const base = lines.slice(0, target).join('\n').length + (target > 0 ? 1 : 0)
    setCursor(base + newOffset)
  }

  useInput(
    (input, key) => {
      if (disabled || menuOpen) return
      if (key.return && !key.shift) {
        const trimmed = value.trim()
        if (trimmed) {
          historyRef.current.push(trimmed)
          histIdxRef.current = -1
          updateValue('')
          setCursor(0)
          onSend(trimmed)
        }
        return
      }
      if (key.return && key.shift) {
        insert('\n')
        return
      }
      if (key.backspace) {
        backspace()
        return
      }
      if (key.delete) {
        del()
        return
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1))
        return
      }
      if (key.upArrow) {
        if (multiline) {
          moveLine(-1)
        } else {
          const h = historyRef.current
          if (h.length === 0) return
          histIdxRef.current = histIdxRef.current === -1 ? h.length - 1 : Math.max(0, histIdxRef.current - 1)
          updateValue(h[histIdxRef.current])
          setCursor(h[histIdxRef.current].length)
        }
        return
      }
      if (key.downArrow) {
        if (multiline) {
          moveLine(1)
        } else if (histIdxRef.current !== -1) {
          histIdxRef.current++
          if (histIdxRef.current >= historyRef.current.length) {
            histIdxRef.current = -1
            updateValue('')
            setCursor(0)
          } else {
            updateValue(historyRef.current[histIdxRef.current])
            setCursor(historyRef.current[histIdxRef.current].length)
          }
        }
        return
      }
      if (key.tab) {
        const completed = onTabComplete(value)
        if (completed !== null) {
          updateValue(completed)
          setCursor(completed.length)
        }
        return
      }
      if (input) {
        histIdxRef.current = -1
        insert(input)
      }
    },
    { isActive: process.stdin.isTTY === true },
  )

  const shown = disabled ? '' : value
  const shownCursor = Math.min(cursor, shown.length)
  return (
    <Box>
      <Text color="green">❯ </Text>
      {shown.length === 0 ? (
        <Text dimColor>{placeholder ?? (disabled ? '生成中…' : '输入消息（Enter 发送，Shift+Enter 换行，↑↓ 历史，Tab 补全）')}</Text>
      ) : (
        <Text>
          {shown.slice(0, shownCursor)}
          <Text backgroundColor="#565F89">{shown[shownCursor] ?? ' '}</Text>
          {shown.slice(shownCursor + 1)}
        </Text>
      )}
    </Box>
  )
}
