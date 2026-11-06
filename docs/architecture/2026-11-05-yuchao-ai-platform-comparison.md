# 驭潮可配置智能体平台选型

日期：2026-11-05。核验方式：官方仓库、许可证、官方文档；尚未部署或运行候选平台。需求：个人付费租户、可配置智能体/工具、联网研究、驭潮指标工具、图表动作、持续任务与飞书/微信。

## 层级与选择

LangGraph是程序化编排框架，不能直接提供完整的智能体创建后台、工具配置页和用户产品。当前需求应先评估上层平台，不预先决定裸LangGraph自研。若选平台已自带运行引擎，不再额外叠一套LangGraph，除非有平台无法满足的独立工作流。

建议优先验证Langflow与Coze Studio。Langflow更适合Python工具集成、嵌入式服务及宽松许可下改造；Coze Studio更贴近完整智能体搭建产品，但社区版工作区/企业协作等能力缺失，不能当成现成付费多租户底座。接受商业授权时，Dify为完整配置平台的强候选。

## 已核验候选

|项目|配置能力|许可/社区版边界|对驭潮的判断|
|---|---|---|---|
|Langflow|可视化Agent/流程、工具动作配置、MCP、API、Python组件|仓库MIT；有内置账户/API鉴权，但不等于完成付费SaaS租户治理|优先PoC；普通用户使用驭潮自己的简化配置，不直接暴露可执行自定义Python的编辑器|
|Coze Studio|智能体、人设、插件、知识库、工作流、调试、对话/工作流API和Chat SDK|仓库Apache-2.0；官方FAQ称开源版不含工作空间、企业组织管理、多人协作；商业SaaS插件可能另收费|完整配置体验强候选；以平台内部模板开发为起点，租户与用户产品仍归驭潮；不能预设社区版已有租户隔离|
|Dify|Agent、工具/MCP、知识库、工作流、模型管理、日志|Dify License允许商业后端，但多租户环境/多workspace需书面授权；前端标识有附加条款|愿意获得适当商业授权时的强候选；不把一个workspace多终端用户与多workspace租户混为一谈，也不以共享workspace绕过隔离|
|MaxKB|Agent工作流、函数/工具、RAG、MCP|GPLv3；不同商业版功能需逐项核对|中文运营后台候选；部署、改造和交付方式需按GPL义务评估，不直接推断整个独立驭潮必须开源|
|FastGPT|知识库问答、可视化AI流程与工具|基于Apache附加限制；类似FastGPT的多租户SaaS与控制台标识有授权条款|候选，但须按驭潮实际产品形态确认适用范围，不能简单当纯Apache|
|Flowise|Agentflow、工具、API与可视化流程|开源部分Apache，enterprise目录商业许可；workspace仅Cloud/Enterprise；官方仓库当前archived=true，最后push 2026-08-13|当前不作为新项目首选；不以历史口碑替代维护状态|

许可证结论限于核验文本与当前方案的筛选，不替代具体商业授权范围确认；第三方插件、模型及托管服务分别计费/授权。开源平台有账户、API不意味着商业套餐、支付、任务和私有数据隔离已完成。

## 配置面向两类人

平台管理员：模型供应商、搜索服务、PDF解析、公司/资金/财报工具、指标筛选、图表动作和任务工具；工具参数schema、鉴权、超时、版本、发布范围、运行日志。数据查询和任务操作通过驭潮网关，tenant_id由可信登录上下文注入，不靠提示词隔离。

付费个人：创建/复制机器人模板，配置名称、人设与用途、允许的工具、股票池、报告偏好、任务频率、提醒渠道与预算。保留自然语言创建/修改。一般用户不需要直接操作通用节点画布，也不开放宿主机代码/任意数据库工具。

用户创建的机器人配置/版本仍存驭潮，平台负责执行发布的模板/应用；平台具体能否安全地通过API映射每用户配置，需PoC验证，不能预设支持动态改参或把user变量当权限。

## 建议接入结构

驭潮账户/租户/计费/机器人页面 → AI网关 → 选定平台API → 驭潮受控工具API或MCP → 行情/资金/指标/财报/公告/图表/任务。

持续盯盘、交易日20点任务、有效期、失败重试和推送幂等依然由驭潮任务系统管理。平台智能体可以创建任务、查询进度和解释命中，不持续占用模型盯价格。

## 同题PoC，不按功能宣传直接拍板

1. 联网研究：阳光电源主营＋最近资金＋最新季报。必须用真实工具取数，引用来源，财务期和数据时间一致，查看工具调用记录、延迟、费用。
2. 一句话建立盯盘，并继续修改同一任务。任务规则可读、保存幂等、关掉会话后继续运行，飞书通知可追溯。
3. 两个个人账号各建机器人：不能访问对方会话、报告、自选、凭据与任务；更改提示词或工具参数也无法跨租户。
4. 接入图表动作：仅返回允许的指标/时间价格锚点，经驭潮校验后执行并能撤销。

比较部署复杂度、必需商业功能、工具调用成功率、配置API能力、流式响应、模型兼容、日志与任务恢复后定选。无需先安装所有候选，更不同时维护平台和自研智能体框架。

## 官方来源

- Langflow工具：https://docs.langflow.org/agents-tools
- Langflow能力：https://github.com/langflow-ai/langflow
- Langflow许可证：https://github.com/langflow-ai/langflow/blob/main/LICENSE
- Langflow鉴权：https://docs.langflow.org/api-keys-and-authentication
- Coze Studio：https://github.com/coze-dev/coze-studio
- Coze Studio中文功能：https://github.com/coze-dev/coze-studio/blob/main/README.zh_CN.md
- Coze许可证：https://github.com/coze-dev/coze-studio/blob/main/LICENSE-APACHE
- Coze开源/商业差别：https://docs.coze.cn/guides_FAQ
- Dify：https://github.com/langgenius/dify
- Dify许可：https://github.com/langgenius/dify/blob/main/LICENSE
- MaxKB：https://github.com/1Panel-dev/MaxKB
- MaxKB许可：https://github.com/1Panel-dev/MaxKB/blob/v2/LICENSE
- FastGPT许可：https://github.com/labring/FastGPT/blob/main/LICENSE
- Flowise许可及归档状态：https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md
- Flowise workspace：https://docs.flowiseai.com/using-flowise/workspaces
- Flowise仓库元数据：https://api.github.com/repos/FlowiseAI/Flowise

## 接入重量与现有Octop/DeerFlow候选更新

用户提出减少平台叠加并比较DeerFlow、Octop。已核验两者官方及本地源码；按个人助手、多Agent配置、通道和任务体验，下一步优先验证Octop独立服务接入，不额外同时部署DeerFlow或自建LangGraph层。DeerFlow保留为深度研究候选。单进程不等于运行轻量，实际资源、商业租户隔离与渠道能力未测。详见同目录`2026-11-05-yuchao-octop-deerflow-assessment.md`。
