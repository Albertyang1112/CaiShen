// CategorySelect.jsx — a native <select> of categories, grouped into <optgroup>s by
// section, each option showing its full "Section › Group › Leaf" path. Shared by the
// Add-category parent picker and the drawer's Move picker.

import { TYPE_META } from './coaConfig'

export default function CategorySelect({ value, onChange, options, placeholder = 'Choose a category…', style }) {
  // Group options under "Section · scope" headers, preserving the incoming order.
  const groups = []
  const seen = new Map()
  for (const o of options) {
    const key = `${o.type}|${o.scope || ''}`
    let g = seen.get(key)
    if (!g) { g = { key, label: `${TYPE_META[o.type]?.label || o.type}${o.scope ? ' · ' + o.scope : ''}`, items: [] }; seen.set(key, g); groups.push(g) }
    g.items.push(o)
  }
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)} style={{ width: '100%', fontSize: 13, ...style }}>
      <option value="">{placeholder}</option>
      {groups.map(g => (
        <optgroup key={g.key} label={g.label}>
          {g.items.map(o => (
            <option key={o.id} value={o.id}>{o.path.join(' › ')}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
