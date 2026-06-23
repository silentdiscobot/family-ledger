App({
  globalData: {
    apiBase: "http://127.0.0.1:5050",
    cookie: wx.getStorageSync("cookie") || "",
    user: wx.getStorageSync("user") || null
  },
  setCookie(cookies) {
    if (!cookies || !cookies.length) return;
    const cookie = cookies.map((item) => item.split(";")[0]).join("; ");
    this.globalData.cookie = cookie;
    wx.setStorageSync("cookie", cookie);
  },
  setUser(user) {
    this.globalData.user = user;
    wx.setStorageSync("user", user);
  },
  logout() {
    this.globalData.cookie = "";
    this.globalData.user = null;
    wx.removeStorageSync("cookie");
    wx.removeStorageSync("user");
  }
});
