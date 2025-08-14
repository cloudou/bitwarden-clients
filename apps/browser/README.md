[![Github Workflow build browser on main](https://github.com/bitwarden/clients/actions/workflows/build-browser.yml/badge.svg?branch=main)](https://github.com/bitwarden/clients/actions/workflows/build-browser.yml?query=branch:main)
[![Crowdin](https://d322cqt584bo4o.cloudfront.net/bitwarden-browser/localized.svg)](https://crowdin.com/project/bitwarden-browser)
[![Join the chat at https://gitter.im/bitwarden/Lobby](https://badges.gitter.im/bitwarden/Lobby.svg)](https://gitter.im/bitwarden/Lobby)

# Bitwarden Browser Extension

<a href="https://chromewebstore.google.com/detail/bitwarden-free-password-m/nngceckbapebfimnlniiiahkandclblb" target="_blank"><img src="https://imgur.com/3C4iKO0.png" width="64" height="64"></a>
<a href="https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/" target="_blank"><img src="https://imgur.com/ihXsdDO.png" width="64" height="64"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/bitwarden-free-password/jbkfoedolllekgbhcbcoahefnbanhhlh" target="_blank"><img src="https://imgur.com/vMcaXaw.png" width="64" height="64"></a>
<a href="https://addons.opera.com/extensions/details/bitwarden-free-password-manager/" target="_blank"><img src="https://imgur.com/nSJ9htU.png" width="64" height="64"></a>
<a href="https://bitwarden.com/download/" target="_blank"><img src="https://imgur.com/ENbaWUu.png" width="64" height="64"></a>
<a href="https://chromewebstore.google.com/detail/bitwarden-free-password-m/nngceckbapebfimnlniiiahkandclblb" target="_blank"><img src="https://imgur.com/EuDp4vP.png" width="64" height="64"></a>
<a href="https://chromewebstore.google.com/detail/bitwarden-free-password-m/nngceckbapebfimnlniiiahkandclblb" target="_blank"><img src="https://imgur.com/z8yjLZ2.png" width="64" height="64"></a>
<a href="https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/" target="_blank"><img src="https://imgur.com/MQYBSrD.png" width="64" height="64"></a>

The Bitwarden browser extension is written using the Web Extension API and Angular.

![My Vault](https://raw.githubusercontent.com/bitwarden/brand/main/screenshots/web-browser-extension-generator.png)

## Documentation

Please refer to the [Browser section](https://contributing.bitwarden.com/getting-started/clients/browser/) of the [Contributing Documentation](https://contributing.bitwarden.com/) for build instructions, recommended tooling, code style tips, and lots of other great information to get you started.

深入分析 src/platform 目录，总结主要流程是怎样的，和哪些组件有交互，找出复杂、难懂的部分，可以参考 docs/autofill/services/inline-menu-field-qualification-service-analysis.md 的格式，在docs/autofill/platform目录创建新的md文档，可视化的、详细的、真实的反应 src/platform 的功能点，重点关注对跨浏览器（chrome、firfox、safari）的基础的api都进行了哪些统一封装，有哪些兼容处理，最好能有条理的一一列明，需要使用中文输出，在生成完md文档后，需要严格的依据源代码审核一遍，确保文档内容真实、准确的反应源代码。
