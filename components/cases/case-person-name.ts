/** Present the name from the existing "name · email" label without changing the source data. */
export function casePersonName(label: string): string {
  const parts = label.split(' · ');
  const contact = parts.at(-1)?.trim() ?? '';
  if (parts.length < 2 || (!/^[^\s@]+@[^\s@]+$/.test(contact) && contact !== '未提供邮箱' && contact !== '未提供郵箱')) return label;
  const name = parts.slice(0, -1).join(' · ').trim();
  return name && name !== '未设置昵称' && name !== '未設置暱稱' ? name : contact;
}
