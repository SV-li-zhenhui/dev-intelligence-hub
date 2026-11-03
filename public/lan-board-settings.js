const dialog = document.querySelector("#lan-board-dialog");
const form = document.querySelector("#lan-board-form");
const status = document.querySelector("#lan-board-status");
const submit = form.querySelector('button[type="submit"]');

async function request(settings) {
  const response = await fetch("/api/lan-task-board", settings ? {
    method: "POST",
    headers: { "content-type": "application/json", "x-mydashboard-action": "1" },
    body: JSON.stringify(settings),
  } : { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法更新看板");
  return body;
}

function show(settings) {
  form.elements.enabled.checked = settings.enabled;
  form.elements.host.value = settings.host;
  form.elements.allow.value = settings.allow.join("\n");
  status.textContent = settings.url ? `同事访问地址 ${settings.url}` : "局域网查看已关闭";
}

document.querySelector("#lan-board-open").addEventListener("click", async () => {
  status.textContent = "正在读取设置…";
  submit.disabled = true;
  dialog.showModal();
  try {
    show(await request());
    submit.disabled = false;
  } catch (error) {
    status.textContent = error.message;
  }
});
document.querySelector("#lan-board-close").addEventListener("click", () => dialog.close());

form.addEventListener("submit", async event => {
  event.preventDefault();
  submit.disabled = true;
  try {
    show(await request({
      enabled: form.elements.enabled.checked,
      host: form.elements.host.value.trim(),
      allow: form.elements.allow.value.split(/[\s,，]+/u).filter(Boolean),
    }));
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
