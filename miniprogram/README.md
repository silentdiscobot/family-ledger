# 家庭记账小程序前端

这是从网页版剥离出来的微信小程序前端，网页版仍然由 `templates/index.html` 和 `static/app.js` 提供。

## 模块

- 统计：总览、流水、导入导出
- 记一笔：文字记账、手动记账
- 设置：预算、分类、成员、周期账单、资产负债、账户

## 使用

1. 启动 Flask 后端：

   ```bash
   python3 app.py
   ```

2. 微信开发者工具导入：

   ```text
   /Users/yuanzhaohao/Project/family-ledger/miniprogram
   ```

3. 本地调试关闭“校验合法域名”。

默认接口地址在 `app.js` 中：

```js
apiBase: "http://127.0.0.1:5050"
```
