const app = getApp();
const { request } = require("../../utils/api");

function money(value, digits = 0) {
  return `¥${Number(value || 0).toFixed(digits)}`;
}

function recordAmount(item) {
  return `${item.type === "income" ? "+" : "-"}${money(item.amount, 2)}`;
}

Page({
  data: { active: "overview", importing: false, importText: "", summary: {}, recent: [], records: [] },
  onShow() {
    if (!app.globalData.cookie) return wx.redirectTo({ url: "/pages/login/login" });
    this.load();
  },
  setTab(event) {
    this.setData({ active: event.currentTarget.dataset.tab });
  },
  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },
  async load() {
    const month = new Date().toISOString().slice(0, 7);
    const [summary, records] = await Promise.all([request(`/api/summary?month=${month}`), request("/api/transactions")]);
    this.setData({
      summary: { incomeText: money(summary.income), expenseText: money(summary.expense), netText: money(summary.net), netWorthText: money(summary.netWorth) },
      recent: summary.recent.map((item) => ({ ...item, amountText: recordAmount(item) })),
      records: records.map((item) => ({ ...item, amountText: recordAmount(item) }))
    });
  },
  copyExport() {
    const header = "date,type,amount,category,account,member,note";
    const lines = this.data.records.map((item) => [item.occurred_on, item.type, item.amount, item.category_name || "", item.account_name || "", item.member_name || "", item.note || ""].join(","));
    wx.setClipboardData({ data: [header, ...lines].join("\n") });
  },
  async importCsv() {
    this.setData({ importing: true });
    try {
      const result = await request("/api/import/transactions", { method: "POST", data: { csv: this.data.importText } });
      wx.showToast({ title: `导入 ${result.created} 条` });
      this.setData({ importText: "" });
      await this.load();
    } finally {
      this.setData({ importing: false });
    }
  }
});
