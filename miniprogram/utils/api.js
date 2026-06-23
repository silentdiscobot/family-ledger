const app = getApp();

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${app.globalData.apiBase}${path}`,
      method: options.method || "GET",
      data: options.data || {},
      header: {
        "content-type": "application/json",
        Cookie: app.globalData.cookie || ""
      },
      success(res) {
        app.setCookie(res.cookies);
        if (res.statusCode === 401) {
          app.logout();
          wx.redirectTo({ url: "/pages/login/login" });
          reject(new Error("unauthorized"));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(JSON.stringify(res.data)));
          return;
        }
        resolve(res.data);
      },
      fail: reject
    });
  });
}

module.exports = { request };
