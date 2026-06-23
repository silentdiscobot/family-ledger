const state = {
  householdAdmins: [],
  currentUser: null,
};

window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

function $(selector) {
  return document.querySelector(selector);
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 1800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function roleText(role) {
  return {
    super_admin: "超级管理员",
    household_admin: "家庭管理员",
    editor: "可记账成员",
    viewer: "只读成员",
  }[role] || role || "账号";
}

function renderHouseholdAdmins() {
  const list = $("#householdAdminList");
  list.innerHTML =
    state.householdAdmins
      .map(
        (item) => `
          <div class="list-item managed-item">
            <span>${item.household_name}<small>${item.display_name} · ${item.username}</small></span>
            <strong>${roleText(item.role)}</strong>
            <button class="danger-btn" data-delete-household="${item.household_id}">删除</button>
          </div>
        `,
      )
      .join("") || '<p class="muted">暂无已创建的家庭管理员账号。</p>';
}

async function load() {
  Object.assign(state, await api("/api/admin/bootstrap"));
  renderHouseholdAdmins();
}

$("#householdForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api("/api/households", {
      method: "POST",
      body: JSON.stringify(data),
    });
    form.reset();
    toast("新家庭已创建，可用新账号登录");
    await load();
  } catch (error) {
    const message = error.message.includes("username exists")
      ? "用户名已存在"
      : error.message.includes("password too short")
        ? "密码至少需要 6 位"
        : error.message.includes("display name must be chinese")
          ? "用户名称必须是 2-12 个中文字符"
          : error.message.includes("username must be english")
            ? "登录用户名只能使用 3-24 个英文字母"
            : error.message.includes("forbidden")
              ? "当前账号没有权限执行此操作"
              : "保存失败，请检查输入";
    toast(message);
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-household]");
  if (!button) return;
  try {
    await api(`/api/households/${button.dataset.deleteHousehold}`, { method: "DELETE" });
    toast("家庭管理员账号已删除");
    await load();
  } catch (error) {
    const message = error.message.includes("protected household") ? "不能删除默认家庭或当前家庭" : "删除失败";
    toast(message);
  }
});

load().catch((error) => {
  console.error(error);
  toast("加载失败，请检查服务是否正常");
});
