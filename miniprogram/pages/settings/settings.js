const app = getApp();
const { request } = require("../../utils/api");

function money(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

Page({
  data: {
    active: "budget",
    accounts: [],
    categories: [],
    members: [],
    recurring: [],
    assets: [],
    budgetAmount: "",
    categoryName: "",
    memberName: "",
    recurringName: "",
    recurringAmount: "",
    assetName: "",
    assetAmount: "",
    accountName: "",
    accountBalance: ""
  },
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
    const data = await request(`/api/bootstrap?month=${new Date().toISOString().slice(0, 7)}`);
    const budget = data.budgets.find((item) => item.category_id === null);
    this.setData({
      accounts: data.accounts.map((item) => ({ ...item, balanceText: money(item.balance) })),
      categories: data.categories.map((item) => ({ ...item, typeText: item.type === "income" ? "收入" : "支出" })),
      members: data.members,
      recurring: data.recurring.map((item) => ({ ...item, amountText: money(item.amount) })),
      assets: data.assets.map((item) => ({ ...item, amountText: money(item.amount) })),
      budgetAmount: budget ? String(budget.amount) : this.data.budgetAmount
    });
  },
  async saveBudget() {
    await request("/api/budgets", { method: "POST", data: { month: new Date().toISOString().slice(0, 7), amount: this.data.budgetAmount } });
    wx.showToast({ title: "已保存" });
    this.load();
  },
  async saveCategory() {
    await request("/api/categories", { method: "POST", data: { name: this.data.categoryName, type: "expense", color: "#38bdf8" } });
    this.setData({ categoryName: "" });
    wx.showToast({ title: "已添加" });
    this.load();
  },
  async saveMember() {
    await request("/api/members", { method: "POST", data: { name: this.data.memberName, role: "成员" } });
    this.setData({ memberName: "" });
    wx.showToast({ title: "已添加" });
    this.load();
  },
  async saveRecurring() {
    const category = this.data.categories.find((item) => item.type === "expense");
    const account = this.data.accounts[0];
    const member = this.data.members[0];
    await request("/api/recurring", { method: "POST", data: { name: this.data.recurringName, type: "expense", amount: this.data.recurringAmount, category_id: category.id, account_id: account.id, member_id: member.id, day_of_month: 1, active: true } });
    this.setData({ recurringName: "", recurringAmount: "" });
    wx.showToast({ title: "已添加" });
    this.load();
  },
  async saveAsset() {
    await request("/api/assets", { method: "POST", data: { name: this.data.assetName, type: "asset", amount: this.data.assetAmount } });
    this.setData({ assetName: "", assetAmount: "" });
    wx.showToast({ title: "已添加" });
    this.load();
  },
  async saveAccount() {
    await request("/api/accounts", { method: "POST", data: { name: this.data.accountName, balance: this.data.accountBalance, type: "wallet", color: "#38bdf8" } });
    this.setData({ accountName: "", accountBalance: "" });
    wx.showToast({ title: "已添加" });
    this.load();
  }
});
