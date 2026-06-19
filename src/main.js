import './style.css'
import { Editor, Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import Paragraph from '@tiptap/extension-paragraph'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'

// Adds a boolean `locked` attribute to a node, round-tripped via `data-locked`.
// Locked nodes get a `data-locked` attribute + class so we can style/detect them.
function withLockedAttr(extension) {
  return extension.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        locked: {
          default: false,
          parseHTML: (el) => el.getAttribute('data-locked') === 'true',
          renderHTML: (attrs) =>
            attrs.locked ? { 'data-locked': 'true', class: 'locked' } : {},
        },
      }
    },
  })
}

const LockedParagraph = withLockedAttr(Paragraph)
const LockedTableCell = withLockedAttr(TableCell)

// Rejects any transaction whose changes overlap a locked node's range.
// filterTransaction is a ProseMirror *plugin* hook (not an editorProp), so it
// must be registered via a Plugin for ProseMirror to actually consult it.
const LockGuard = Extension.create({
  name: 'lockGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction(transaction, state) {
          if (!transaction.docChanged) return true // selection-only changes are fine

          // Collect the document ranges occupied by locked nodes.
          const lockedRanges = []
          state.doc.descendants((node, pos) => {
            if (node.attrs.locked) lockedRanges.push([pos, pos + node.nodeSize])
          })
          if (lockedRanges.length === 0) return true

          // Block the transaction if any step touches a locked range.
          let allowed = true
          transaction.steps.forEach((step) => {
            step.getMap().forEach((fromA, toA) => {
              for (const [from, to] of lockedRanges) {
                if (fromA < to && toA > from) allowed = false
              }
            })
          })
          return allowed
        },
      }),
    ]
  },
})

const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: [
    StarterKit.configure({ paragraph: false }), // use our locked-aware paragraph instead
    LockedParagraph,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    LockedTableCell,
    LockGuard,
  ],
  content: `
    <h1>Title</h1>
    <p data-locked="true">This is a paragraph 1. Start typing here (non modifiable).</p>
    <p data-locked="true">This is a paragraph 2. Start typing here (non modifiable).</p>
    <p>This is a paragraph 3. Start typing here (modifiable).</p>
    <table>
      <tbody>
        <tr>
          <th>Name</th>
          <th>Value</th>
        </tr>
        <tr>
          <td data-locked="true">Cell A (non modifiable)</td>
          <td>Cell B (modifiable)</td>
        </tr>
      </tbody>
    </table>
  `,
})

document.querySelector('#add-table').addEventListener('click', () => {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
})
