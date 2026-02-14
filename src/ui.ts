export function updateStatus(text: string) {
  const el = document.getElementById("status")
  if (el) el.innerText = text
}

