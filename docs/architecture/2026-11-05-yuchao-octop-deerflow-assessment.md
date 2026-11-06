# 驭潮：Octop与DeerFlow接入评估

日期：2026-11-05。范围：官方仓库/许可证及本地源码静态核对，未启动新服务、未改其他项目、未测资源与真实渠道。Octop指TencentCloud/Octop。

## 结论

完整叠加可视化智能体平台会引入独立配置、账号、凭据、存储和发布生命周期。驭潮当前以个人助手、自然语言建任务、多渠道交互为主，更值得先验证Octop独立AI服务接入；DeerFlow作为复杂研究候选，不在第一阶段再叠加部署。若Octop能完成研究就不额外引入DeerFlow。LangGraph作为底层依赖不需要再额外自建另一套智能体层。

这是按需求匹配与源码结构的推荐，不是资源、准确率和隔离压测后的结论。已有两套本地源码可直接研究，减少重新引入陌生平台的成本，但本地checkout可能含改动，不与上游稳定发布混称。

## 实际核验

Octop本地`/Users/neo/workspace/octop/pyproject.toml`为1.0.2b5，octop-new为1.0.2b6。项目依赖FastAPI、APScheduler、JWT、PostgreSQL、MCP、octop-harness[all]、gateway、memory、browser、Playwright以及文档解析库。因此单进程不等于依赖少、内存小或模型成本低，生产评估应固定合适稳定版本。

Octop README与代码可见：多用户JWT、每用户多个Agent、独立工作区/供应商/通道/定时任务、Web配置、MCP连接器、HTTP/SSE/WebSocket。cron路由创建时调用require_agent_row及管理权限检查，任务关联agent_id和user_id；这证明存在权限与归属设计，不代表跨租户越权测试已通过。

`api/routers/cron.py`的创建对象主要是trigger+prompt+agent/model/mcp配置。适合每晚跑报告，不等同于“行情持续监测＋边沿触发＋交易日有效期＋一次性结束”。不要每分钟调智能体问一次股票是否回调，应该由驭潮条件引擎判定后叫AI解释。

本地Octop通道代码包含WeChat iLink Bot扫码生成/轮询，不能把它与服务号、微信客服、企业微信视为同一接入。可在PoC尝试该路由，但开放范围、用户绑定、主动发送、菜单/卡片能力及适用业务需单独核验；不能仅按README写WeChat就承诺外部客户场景全部满足。

DeerFlow本地`/Users/neo/workspace/deerflow/backend/pyproject.toml`为2.2.0-dev，依赖分离的harness与extension-api，含LangGraph相关依赖。README与架构文档显示其是长程任务harness，支持研究、工具/MCP、技能、记忆、产物、沙箱和子任务，也已有认证、IM和定时任务，不能说这些是Octop独占。

本地DeerFlow README的部署建议：本地评估起点4vCPU/8GB，长期共享服务器起点8vCPU/16GB，均不含本地模型。这是该checkout文档建议，不是实测硬性下限，也不能外推嵌入式裁剪运行所需资源。是否仅用后端/嵌入客户端能明显减轻负担，需实际验证。

双方主仓库许可证均MIT；各自依赖、插件、模型与外部服务仍独立考虑。

## 分工

- Octop：对话、用户Agent配置、人设、模型/工具、记忆、通道入口；研究由工具组合完成。
- 驭潮：登录/付费套餐主身份、行情、指标、资金、筛选、图表动作、条件盯盘、交易日历、任务与报告事实。
- 持久任务唯一归属：市场相关任务以驭潮账本为准，Agent创建/修改/查询任务通过工具调用。不再维护两套同义盯盘任务。Octop通用cron若用于个人助手任务，界面与权限要明确区别；核心标20点推送仍由驭潮交易日与数据就绪机制执行。
- 一次市场事件只产生一次业务消息，由选定投递服务发送；避免驭潮和Octop各推一次。

接入优先独立服务API/MCP，而非把整个Octop并进驭潮Python进程。驭潮保留主界面，逐步嵌入聊天与简化Agent配置；是否直接复用其React控制台需评估认证、嵌入与维护成本，不能假定拿来即用。

身份：驭潮个人租户映射到Octop用户与Agent，后端交换服务凭据；MCP调用携带经过验证的短期用户范围，不把共享管理员key交给浏览器，也不相信消息里的tenant_id。其多用户能力不是现成的个人付费SaaS：套餐、额度、账单、服务到期和推送订阅还要建设。

初始仅开放驭潮查询、搜索/报告读取、图表指令和任务工具；不启用宿主Shell、远程桌面、任意数据库代码；浏览器和多Agent能力确有需求再启用。停用功能不等于默认依赖自动移除，安装体积和运行资源需分别测量。

## 最小验证与决策门槛

1. 单独端口运行固定版本，先不动生产驭潮。
2. 接resolve_symbol、get_indicators、create_watch_task、get_corepicks等少量工具；测试阳光电源条件订阅及交易日20点任务。
3. 测资金＋正式季报＋联网来源的研究问题，确认平台本身是否足够；不先预设必须再上DeerFlow。
4. 用两个账户验证Agent/记忆/文档/工具凭据/任务隔离。
5. 实际飞书收发与卡片、微信iLink外部用户绑定与提醒逐项测试。
6. 测空闲内存、单次研究峰值、5/10并发、工具延迟和模型调用次数，与现有行情进程隔离观察。

通过后可选择Octop为AI交互底座；如果其身份/API/权限改造成本过高，再回到Langflow等候选，不承诺只因功能看起来齐全就一定更省工作。

## 来源

- Octop官方：https://github.com/TencentCloud/Octop
- Octop许可：https://github.com/TencentCloud/Octop/blob/main/LICENSE
- DeerFlow官方：https://github.com/bytedance/deer-flow
- DeerFlow架构：https://github.com/bytedance/deer-flow/blob/main/docs/ARCHITECTURE.md
- DeerFlow许可：https://github.com/bytedance/deer-flow/blob/main/LICENSE
- 本地Octop：README_CN.md、pyproject.toml、src/octop/api/routers/cron.py、channels.py
- 本地DeerFlow：README.md、backend/pyproject.toml、LICENSE
