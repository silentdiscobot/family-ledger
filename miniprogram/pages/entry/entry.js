const app = getApp();
const { request } = require("../../utils/api");

Page({
  data: { quickText: "", amount: "", note: "", accounts: [], categories: [], members: [], accountNames: [], categoryNames: [], memberNames: [], accountIndex: 0, categoryIndex: 0, memberIndex: 0 },
  onShow() {
    if (!app.globalData.cookie) return wx.redirectTo({ url: "/pages/login/login" });
    this.load();
  },
  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },
  async load() {
    const data = await request("/api/bootstrap");
    const categories = data.categories.filter((item) => item.type === "expense");
    this.setData({ accounts: data.accounts, categories, members: data.members, accountNames: data.accounts.map((item) => item.name), categoryNames: categories.map((item) => item.name), memberNames: data.members.map((item) => item.name) });
  },
  setCategory(event) { this.setData({ categoryIndex: Number(event.detail.value) }); },
  setAccount(event) { this.setData({ accountIndex: Number(event.detail.value) }); },
  setMember(event) { this.setData({ memberIndex: Number(event.detail.value) }); },
  inferText(text) {
    const amountMatch = text.match(/(\d+(?:\.\d{1,2})?)/);
    if (!amountMatch) throw new Error("missing amount");
    const account = this.data.accounts.find((item) => text.includes(item.name)) || this.data.accounts[0];
    const category = this.data.categories.find((item) => text.includes(item.name)) || this.data.categories.find((item) => /饭|早餐|午饭|晚饭|吃/.test(text) && item.name.includes("餐")) || this.data.categories[0];
    const member = this.data.members[this.data.memberIndex] || this.data.members[0];
    return { type: "expense", amount: Number(amountMatch[1]), category_id: category.id, account_id: account.id, member_id: member.id, occurred_on: new Date().toISOString().slice(0, 10), note: text.replace(amountMatch[0], "").trim() || category.name };
  },
  async saveText() {
    try {
      await request("/api/transactions", { method: "POST", data: this.inferText(this.data.quickText) });
      this.setData({ quickText: "" });
      wx.showToast({ title: "已保存" });
    } catch (error) { wx.showToast({ title: "识别失败", icon: "none" }); }
  },
  async saveManual() {
    const payload = { type: "expense", amount: Number(this.data.amount), category_id: this.data.categories[this.data.categoryIndex].id, account_id: this.data.accounts[this.data.accountIndex].id, member_id: this.data.members[this.data.memberIndex].id, occurred_on: new Date().toISOString().slice(0, 10), note: this.data.note };
    await request("/api/transactions", { method: "POST", data: payload });
    this.setData({ amount: "", note: "" });
    wx.showToast({ title: "已保存" });
  }
});
