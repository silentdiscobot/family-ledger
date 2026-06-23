const app = getApp();
const { request } = require("../../utils/api");

Page({
  data: {
    username: "",
    password: "",
    loading: false
  },
  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },
  async login() {
    if (!this.data.username || !this.data.password) {
      wx.showToast({ title: "请输入账号和密码", icon: "none" });
      return;
    }
    this.setData({ loading: true });
    try {
      const user = await request("/api/login", {
        method: "POST",
        data: { username: this.data.username, password: this.data.password }
      });
      app.setUser(user);
      wx.switchTab({ url: "/pages/stats/stats" });
    } catch (error) {
      wx.showToast({ title: "登录失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  }
});
