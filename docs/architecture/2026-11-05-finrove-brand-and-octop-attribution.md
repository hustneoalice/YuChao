# 新项目建议：FinRove（研潮）

日期：2026-11-05。命名建议，未创建项目/仓库、未注册商标域名。

## 名称

首选FinRove，仓库finrove，中文研潮。Finance+Rove，表达持续探索市场、研究与机会，不限制为单一选股工具，中文与驭潮保持潮字品牌关联。

英文定位：An open-source AI investment workspace — research, charts, signals, and agents in one place.

中文定位：让研究、看盘、信号与投资助手，在一个工作台协同。

GitHub公开repository search `FinRove in:name` 本轮返回total_count=0（索引范围内初筛，不是唯一性/商标保证）；网页搜索发现FinRove.com域名在售，不代表其他域名可注册，不建议为先创建项目而购买昂贵域名。

未选名称：FinTide已有投资组合应用fintide.app；AlphaTide已有基金经理AI产品；TideDesk已有远程桌面；TideQuant已有PyPI包。因此不继续使用这些候选。

GitHub关注度取决于可运行演示、安装体验、工具扩展文档与差异化，不承诺名称能获得星数。README先展示“一句话建盯盘”“季报研究与来源”“图表动作”“插件工具生态”真实演示。开源与收费边界明确，不把付费服务描述为仓库已包含的免费能力。

## 与现有项目关系

用户最新方向：以Octop为统一平台底座，驭潮页面作为金融业务模块进入同一导航/会话与身份体系；驭潮算法通过金融工具/插件/MCP暴露，形成可演进能力。深度产品融合不等于把全部代码塞入同一Python进程：插件与稳定服务接口保持演进边界。

普通指标可随开源金融工具开放；需保护的自有核心算法放服务端，预置插件/MCP只提供schema、参数、结果与UI，按服务端账户订阅鉴权。已发给用户的Python/JS算法不能靠简单隐藏/加密插件保证保密。MIT不强制将新增独立算法服务开源，仍须单独核对每项依赖/算法来源的权利与许可。

原版/近似/约定规则来源标签继续保留。未验证的复刻不能因收费就改称已恢复原版。

## 当前竞品/参照

- OpenBB：开放金融数据平台＋Workspace UI/AI集成；开源数据底座不等于整个商业Workspace都开源。https://github.com/openbq-org/OpenBB
- Fincept Terminal：行情分析、研究终端与AI；开源/企业版范围须区分。https://github.com/Fincept-Corporation/FinceptTerminal
- FinRobot：金融Agent、研究与估值；最新官方仓库还包含桌面研究工作站，不能只按早期AutoGen框架描述。https://github.com/AI4Finance-Foundation/FinRobot
- TradingAgents：多角色研究/决策框架，可对比专家分工与证据链，不等同全功能个人投资工作台。https://github.com/TauricResearch/TradingAgents

差异化建议：A股可操作看盘、前后端同口径指标、自然语言长期任务、金融工具扩展、多渠道交互和可确认事件。不是换皮通用Agent，也不是用回测收益宣传未经验证的效果。

## 用户本地最新源码

`/Users/neo/Downloads/Octop-main.zip` 内`Octop-main/pyproject.toml`为1.0.3b3；本轮只读取压缩包，未解压执行。工作区octop-new仍为1.0.2b6、octop为1.0.2b5、Downloads/octop-neo-main为1.0.2b2。后续新项目以用户最新包为评估基准，beta版本仍应做功能/隔离验收，不能把文件版本较新等同稳定发布。

新版plugins/README_CN.md仍支持tool/skill/hook及聊天UI卡片。产品插件改为市场安装，不再随安装包自带；如发行FinRove需要预置金融插件，应由FinRove发行/安装流程明确管理。现有卡片机制不等同已验证任意整页路由插件能力；完整金融页面融合需继续查前端路由扩展。

## Octop署名

压缩包根LICENSE为MIT，版权行`Copyright (c) 2026 Octop`；浅层未找到额外NOTICE/TRADEMARK文件。MIT允许修改、分发与商业使用，要求保留版权及完整许可文本；不要求新产品名字含Octop。MIT本身不要求固定界面角落显示Powered by，但建议README与关于页清楚致谢，避免暗示腾讯/Octop官方出品或背书。

直接派生仓库建议保留原LICENSE和原文件版权，新增文件写FinRove contributors版权；不要用自己版权整体替换上游版权。THIRD_PARTY_NOTICES.md记录上游及版本，third_party/licenses/octop-MIT.txt保留完整上游许可（目录名建议，未创建）。依赖包许可分别保留。

README建议：

> FinRove is an independent AI investment workspace built on Octop, with financial charting and market-analysis capabilities powered by YuChao.
>
> We thank the Octop contributors for the agent platform foundation. Octop is licensed under the MIT License; its original copyright and license notices are retained.
>
> FinRove is an independent project and is not an official Tencent Cloud or Octop product.

中文关于页建议：研潮基于Octop构建，集成驭潮金融看盘与分析能力。感谢Octop及其贡献者。研潮为独立项目，非腾讯云或Octop官方产品。

推荐fork或保留可追溯上游Git历史，便于后续升级；用户下载zip作为当前阅读基准不妨碍后续建立上游来源记录。

## 新项目工作说明（可复制到新聊天）

新项目暂名FinRove（研潮），定位AI金融投资工作台。以本地`/Users/neo/Downloads/Octop-main.zip`中的1.0.3b3为评估基准，基于Octop深度融合金融业务，而非只与驭潮互相跳转。将驭潮看盘/全景/筛选/核心标等作为业务页面接入统一导航，指标、资金、报告、任务封装为受控金融工具/插件或MCP。私人付费租户统一身份、工具授权和额度；需保密核心算法留服务端，开源客户端预置入口。复用Agent配置、工具配置和消息通道，但验证实际权限与稳定性。先分析最新版本页面/插件扩展与单一身份方案，再按确认设计实施。保持驭潮工程可独立演进，不覆盖其未提交改动；保留Octop MIT声明和上游来源。核心场景：阳光电源自然语言盯盘、交易日20点核心标推送、联网季报研究、图表指标与画线。不得把近似指标标为众赢原公式。
