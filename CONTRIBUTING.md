# Contributing to agy-capsule

[中文](#中文) | [English](#english)

## 中文

欢迎提 Issue 和 PR。小改动可以直接开 PR，不用先发 Issue。建议从最新的 `main` 开分支。

1. **新增展示或交互**：优先复用现有组件和交互，让新功能和插件的其他部分保持一致。如果新的布局或交互能解决现有问题，也欢迎提出，在 PR 里说明原因即可。会改变默认体验的新功能做成设置项，默认关闭；如果有只为它服务的后台计算，关闭时也跳过。
2. **修 Bug 或提性能**：不改变用户原有选择的修复和优化，可以直接改，不必额外加开关。
3. **方便 review**：一个 PR 尽量只做一件事。UI 改动附截图；如果有开关，请说明默认和开启后的效果。涉及整体布局或数据口径的大改动，建议先开 Issue 讨论方向。

改动代码时，请跑与改动相关的[测试](./README.md#开发测试)，并在 PR 里说明测了什么。开 PR 时会自动带出模板，请按模板列出所有默认体验的变化；如果 PR 说明由 AI 生成，请提交前逐条核对，确认与实际改动一致。

## English

Issues and pull requests are welcome. For small changes, feel free to open a PR directly. Start from the latest `main` when possible.

1. **New UI or interactions:** Prefer existing components and interactions so new features feel consistent with the rest of the plugin. Different layouts or interactions are welcome if they solve a problem; explain why in the PR. If a new feature would change the default experience, make it a setting that's off by default. Skip any background work specific to it when it's off.
2. **Bug fixes and performance:** Fixes and optimizations that preserve users' choices don't need a new toggle.
3. **Make reviews easy:** Keep each PR focused on one change. Include a screenshot for UI changes and, if there's a toggle, describe what users see by default and after enabling it. For major layout changes or changes to how metrics are defined, consider opening an issue to discuss the direction first.

For code changes, run the relevant [tests](./README.en.md#development-tests) and mention what you checked in the PR. The PR template opens automatically; use it to list every change to the default experience. If AI wrote your PR description, check it line by line against the actual changes before submitting.
