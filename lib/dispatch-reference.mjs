export const dispatchReference = (date, boxId) => date.replaceAll('-', '') + '9' + String(boxId).padStart(9, '0');

export function dispatchBoxId(reference) {
  const match = /^\d{8}9(\d{9})$/.exec(reference);
  return match ? Number(match[1]) : 0;
}
