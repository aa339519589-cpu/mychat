export type DiffLine = { type: "same" | "add" | "del"; text: string }

/** Compute a deterministic line diff using LCS, with a bounded fallback for large inputs. */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  if (oldLines.length > 600 || newLines.length > 600) {
    return [
      ...oldLines.map(text => ({ type: "del" as const, text })),
      ...newLines.map(text => ({ type: "add" as const, text })),
    ]
  }

  const rows = oldLines.length
  const columns = newLines.length
  const lengths: number[][] = Array.from({ length: rows + 1 }, () => new Array(columns + 1).fill(0))
  for (let row = 1; row <= rows; row++) {
    for (let column = 1; column <= columns; column++) {
      lengths[row][column] = oldLines[row - 1] === newLines[column - 1]
        ? lengths[row - 1][column - 1] + 1
        : Math.max(lengths[row - 1][column], lengths[row][column - 1])
    }
  }

  const result: DiffLine[] = []
  let row = rows
  let column = columns
  while (row > 0 || column > 0) {
    if (row > 0 && column > 0 && oldLines[row - 1] === newLines[column - 1]) {
      result.unshift({ type: "same", text: oldLines[row - 1] })
      row--
      column--
    } else if (column > 0 && (row === 0 || lengths[row][column - 1] >= lengths[row - 1][column])) {
      result.unshift({ type: "add", text: newLines[column - 1] })
      column--
    } else {
      result.unshift({ type: "del", text: oldLines[row - 1] })
      row--
    }
  }
  return result
}
