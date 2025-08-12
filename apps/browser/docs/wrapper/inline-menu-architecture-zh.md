## 目标与范围

- **目标**: 说明浏览器扩展在页面中如何用 Shadow DOM 包裹 iframe、如何分层承载 UI（按钮/密码列表）、以及 iframe 与扩展背景页之间的通信机制与协议。
- **范围**: `apps/browser` 下的 Autofill Inline Menu（内联菜单）相关实现：页面注入、容器与页面、背景页编排、消息协议与安全隔离。

## 总体架构（Shadow DOM + 双层 iframe）

- **核心理念**: 用双重隔离把网页环境与扩展 UI/逻辑隔开。
  - **页面层（内容脚本）**: 在页面中创建一个宿主元素，并在其上 `attachShadow({ mode: "closed" })`。该 Shadow DOM 内插入“外层 iframe（Menu Container）”。
  - **容器层（外层 iframe）**: 负责路由消息、创建“内层 iframe（按钮/列表 UI）”，并在 `window.postMessage` 与 `chrome.runtime.Port` 之间进行双向转发。
  - **UI 层（内层 iframe）**: 真正渲染按钮/密码列表的页面；页面内部也用 `closed Shadow DOM` 渲染组件，所有用户交互由此发起。

- **主要文件**
  - 页面注入 Shadow + 外层 iframe：
    - `apps/browser/src/autofill/overlay/inline-menu/iframe-content/autofill-inline-menu-iframe-element.ts`
    - `apps/browser/src/autofill/overlay/inline-menu/iframe-content/autofill-inline-menu-iframe.service.ts`
  - 外层 iframe（容器页面 JS/HTML）：
    - `apps/browser/src/autofill/overlay/inline-menu/pages/menu-container/autofill-inline-menu-container.ts`
    - `apps/browser/src/autofill/overlay/inline-menu/pages/menu-container/menu-container.html`
    - `apps/browser/src/autofill/overlay/inline-menu/pages/menu-container/bootstrap-autofill-inline-menu-container.ts`
  - 内层 iframe（UI 页面 JS/HTML）：
    - 按钮：`apps/browser/src/autofill/overlay/inline-menu/pages/button/autofill-inline-menu-button.ts` + `pages/button/button.html`
    - 列表：`apps/browser/src/autofill/overlay/inline-menu/pages/list/autofill-inline-menu-list.ts` + `pages/list/list.html`
    - 抽象基类：`apps/browser/src/autofill/overlay/inline-menu/pages/shared/autofill-inline-menu-page-element.ts`
    - bootstrap：`pages/button/bootstrap-autofill-inline-menu-button.ts`、`pages/list/bootstrap-autofill-inline-menu-list.ts`
  - 背景页（消息编排/业务处理）：
    - `apps/browser/src/autofill/background/overlay.background.ts`
  - 枚举与常量：
    - `apps/browser/src/autofill/enums/autofill-overlay.enum.ts`

## 生命周期与加载流程

1) **内容脚本**在页面创建宿主元素并 `attachShadow({ mode: "closed" })`，在 ShadowRoot 里插入“外层 iframe（`overlay/menu.html`）”

2) **外层 iframe** 加载后，调用 `chrome.runtime.connect({ name })` 连接背景页（端口名对应按钮/列表“元素端口”），并开始监听背景页消息

3) **背景页**在 `onConnect` 时，向元素端口下发初始化数据（包括内层页面 URL/样式/翻译/`portKey`/消息连接器端口名等），并持续下发定位、主题、列表数据等

4) **外层 iframe** 将背景页消息通过 `window.postMessage` 发给自身里的“容器页面脚本（menu-container）”，容器创建“内层 iframe”（`overlay/menu-button.html` 或 `overlay/menu-list.html`），并用“消息连接器端口名”连接背景页，用于承接 UI 发来的业务指令

5) **内层 iframe 页面**（按钮/列表）在自身页面内再 `attachShadow({ mode: "closed" })`，完成 UI 渲染与交互逻辑注册

## 通信机制与消息协议

- **端口定义**（见 `autofill-overlay.enum.ts`）
  - **元素端口**（背景页 ↔ 外层 iframe 服务）：`AutofillOverlayPort.Button` / `AutofillOverlayPort.List`
  - **消息连接器端口**（背景页 ↔ 容器页面）：`AutofillOverlayPort.ButtonMessageConnector` / `AutofillOverlayPort.ListMessageConnector`

- **消息链路**
  - 背景页 → 外层 iframe（元素端口）: 初始化、定位更新、显示/隐藏、颜色方案/主题更新、生成密码更新等
  - 外层 iframe（window.postMessage） → 容器页面: 将上游消息转发给内层页面；自身也可直接处理（如更新外层 iframe 样式）
  - 容器页面 ↔ 内层页面（window.postMessage 双向）: 初始化、列表数据更新、聚焦/模糊、键盘导航、尺寸变化等
  - 内层页面 → 容器页面（window） → 背景页（消息连接器端口）: 业务指令（填充所选条目、解锁、刷新生成密码、新建条目、查看条目、更新高度等）

- **典型命令（部分）**
  - 背景页 → 内层（经外层/容器转发）
    - `initAutofillInlineMenuButton` / `initAutofillInlineMenuList`
    - `updateAutofillInlineMenuListCiphers`（更新密码/卡/身份列表）
    - `updateAutofillInlineMenuColorScheme`（颜色方案同步）
    - `updateAutofillInlineMenuPosition`、`toggleAutofillInlineMenuHidden`、`fadeInAutofillInlineMenuIframe`
  - 内层 → 背景页（经容器转发）
    - `fillAutofillInlineMenuCipher`（填充所选条目，支持 passkey）
    - `unlockVault`、`viewSelectedCipher`、`addNewVaultItem`
    - `updateAutofillInlineMenuListHeight`（ResizeObserver 触发的高度自适应）
    - `refreshGeneratedPassword`、`fillGeneratedPassword`
    - `redirectAutofillInlineMenuFocusOut`、`autofillInlineMenuBlurred`、`checkAutofillInlineMenuButtonFocused`

## 位置与样式控制

- **定位/显隐**：背景页计算位置并通过元素端口推送，外层 iframe 服务统一更新外层 iframe 样式（支持淡入/淡出动画与 aria 提示）
- **高度自适应**：内层列表使用 `ResizeObserver` 计算高度并上报 `updateAutofillInlineMenuListHeight`，背景端/外层据此同步外层 iframe 高度，防止剪裁

## 安全性与隔离策略

- **双层 iframe + 双 `closed` Shadow DOM**：有效阻断站点 CSS/脚本影响扩展 UI
- **MutationObserver 保护**：
  - 宿主/外层 iframe/自定义元素若被站点脚本修改样式/属性，立刻回滚；
  - 外部修改计数超阈值触发强制关闭，避免抖动与性能劣化
- **来源与密钥校验**：
  - 容器仅处理来自父窗口或自身内层 iframe 的消息，校验 `event.origin` 是否在扩展白名单集合中
  - 背景页 per-tab 维护 `portKey`，所有消息需带 `portKey` 才会被受理，防止跨源注入

## 健壮性

- **端口断开处理**：外层服务在 `onDisconnect` 中复位样式、移除监听、断开端口；必要时触发延迟关闭，避免点击事件被吞
- **过度 Mutation 保护**：超频触发将强制关闭内联菜单，保证页面可用性
- **可访问性（ARIA）**：加载/刷新/生成密码等状态通过可选 `aria alert` 通知读屏器

## 可扩展性（新增命令/页面）

- **新增 UI → 背景命令**：
  - 在内层页面通过 `postMessageToParent({ command: "..." })` 发起；
  - 容器侧通常无需改动（透传）；
  - 背景页在对应 `InlineMenu...PortMessageHandlers` 中新增处理分支；必要时回传结果

- **新增 背景 → UI 命令**：
  - 背景页元素端口消息增加新 `command`；
  - 外层服务若无需自处理，则直转发给内层页面；内层注册相应 handler 即可

- **新增页面元素（新内层页面）**：
  - 背景端在初始化时给出新的 `iframeUrl/css/translations/portName`；
  - 容器收到 `init...` 后创建内层 iframe 并连接“消息连接器端口”；
  - 新页面继承 `AutofillInlineMenuPageElement`，完成 UI/交互与消息发送即可

## 性能与体验

- **节流/防抖**：定位更新、滚动加载、列表刷新使用 `throttle/debounce` 降本
- **空闲调度**：容器重排使用 `requestIdleCallback` polyfill 安排非关键任务
- **过渡动画**：外层 iframe 初始透明、按需淡入，减少闪烁

## 兼容性

- **Firefox**：在部分环境下不注册自定义元素，直接使用 `div` + Iframe 封装，避免宿主自定义元素实现差异（见内容服务 `isFirefoxBrowser` 分支）

## 构建与打包

- `overlay/menu.html`、`overlay/menu-button.html`、`overlay/menu-list.html` 由 `webpack` + `HtmlWebpackPlugin` 产出；对应样式与脚本分别打成独立 chunk，供 `manifest.json`/`manifest.v3.json` 声明加载

## 测试策略

- **单元测试覆盖**：
  - 外层服务（iframe 创建、端口连接、消息转发、ARIA、MutationObserver）
  - 容器（来源校验、窗口消息路由、端口转发、初始化）
  - 内层页面（按钮/列表 UI 构造、键盘导航、发令消息、滚动加载、TOTP 倒计时/标签、生成密码视图）
  - 关键测试文件：
    - `.../autofill-inline-menu-iframe.service.spec.ts`
    - `.../autofill-inline-menu-container.spec.ts`
    - `.../autofill-inline-menu-button.spec.ts`
    - `.../autofill-inline-menu-list.spec.ts`

## 调试建议

- 用 DevTools “Frames” 面板定位外层/内层 iframe；Console 过滤 `postMessage`
- 背景页端口调试：在 `overlay.background.ts` 的 `postMessageToPort/handlePortOnConnect` 加日志
- 检查 `portKey`、端口名、`event.origin` 是否匹配；观察是否被 MutationObserver 频繁回滚

## 风险与应对

- 站点脚本强改样式/属性 → MutationObserver 统一回滚，超限强制关闭
- 嵌套 frame 定位不准 → 背景端维护 sub-frame offset 并统一计算，必要时触发重建
- 端口早断晚连/竞态 → 外层服务/容器兼容初始化重入；背景端对 `onConnect/onDisconnect` 有序处理

## 变更示例

- 新增命令 `copyTotpToClipboard`：
  - 列表页：`postMessageToParent({ command: "copyTotpToClipboard", inlineMenuCipherId })`
  - 容器：透传；
  - 背景：在 `InlineMenuListPortMessageHandlers` 中新增处理，完成复制后回传状态

- 新增“安全提示”内层页面：
  - 背景：在初始化消息中提供新 `iframeUrl/css/translations/portName`
  - 容器：收到 `initAutofillInlineMenuSecurityPage` 后创建新内层 iframe 并连接端口
  - 新页面：继承 `AutofillInlineMenuPageElement`，实现 UI 与命令发送

## 验收点

- **样式隔离**: 页面样式不影响内外层 UI；MutationObserver 生效
- **功能完备**: 列表数据更新、交互（键盘/鼠标/ARIA）正常；填充、解锁、生成密码等指令全链路可用
- **定位准确**: 多 iframe 嵌套场景定位准确，窗口大小变化时高度自适应
- **稳定性**: 端口断开/重连/快速切换页面稳定不崩

---

本方案文档基于当前代码实现整理（目录：`apps/browser/src/autofill/overlay/inline-menu/**`、`apps/browser/src/autofill/background/**`），用于支撑后续扩展与调试。


