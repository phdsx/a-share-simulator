# A 股模拟器

用 10 万元虚拟资金参与一个持续运行的虚构 A 股市场。查看行情、财报和资讯，提交限价单与条件单，并在交易日结束后复盘。

## 开始交易

在线打开 [A 股模拟器](https://phdsx.github.io/a-share-simulator/)，或在本地用浏览器直接打开 `index.html`。点击「开盘」开始首个交易日。

进度自动保存在当前浏览器。可在「存档」里导出或导入 JSON，以备份进度或迁移到其他浏览器。

## 开发

页面由 HTML、CSS 和 JavaScript 组成。使用 Node.js 运行回归测试。

```sh
node --test market.test.js
```

玩法和市场规则见 [游戏设计](GAME_DESIGN.md)。
