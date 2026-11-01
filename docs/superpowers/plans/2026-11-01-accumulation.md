# 主力吸筹 Implementation Plan

Goal: 将已确认范围的主力吸筹公式接入副图。
Architecture: 纯函数计算，现有 klinecharts 注册表渲染。
Tech Stack: TypeScript, node:test, klinecharts 10.

1. 添加手算、横盘、前缀稳定性测试，确认缺少实现时失败。
2. 实现独立纯函数并运行测试。
3. 注册副图并加入量能分类，构建并检查实际页面。
4. 保存特色指标与验证限制清单。
