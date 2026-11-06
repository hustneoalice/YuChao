# 全景板块与独立主力军情实施计划

用户已批准使用众赢板块分类、驭潮现有资金源，明确全景与主力军情分开。保留所有现有未提交修改，不自动提交。

## 设计与口径

全景只浏览分类、成员与分时/K线，支持39一级行业及子行业；资金页独立导航，共用同一成分关系。主力=capital_flow.net_main，游资=net_medium，散户=net_small，与现有资金卡一致。介入度=同期净额/同期流通市值合计*100，占比=同期净额/同期成交额合计*100。日级收盘数据，默认最新可用资金日期；1/3/5/10/34/55个交易日，比例取累计分子/累计分母，不加总日百分数。行情/资金日期和覆盖率显式展示；缺数据不当零，不回填未来估值。当前成分用于历史统计，说明不能还原历史成分。

## 实施与验收

- [x] 导入：新增 BlockConfig GBK 解析及命令行导入，保留层级、市场过滤；事务写入，来源文件留本地。修复日同步部分成功清空旧成分的问题。测试层级与空数据保留，实库验证白酒19、保险5、全部分类及成员覆盖。
- [x] 军情API：新增独立repo和路由，板块/个股两种视图，分类、日期、周期、搜索、排序分页，成分下钻；真实同源资金聚合、覆盖数和分母配对；测试跨期、缺值、去重、无未来估值和资金分组。
- [x] 页面：新增独立主力军情导航/模块；资金三组净额/介入度/占比、连续净流入、涨停数、净流入最大股，板块到个股再到K线。全景补子级浏览与实际成分数/有行情数。
- [ ] 验证：相关pytest、前端build、真实API数据与浏览器验证，保存全景和军情截图。独立审查新增逻辑并修复重要问题。

模块按subagent-driven-development技能分工：资金后端、独立页面、主代理负责成分导入与全景；共享契约先确定，分工文件不重叠。

## 军情接口契约

GET `/market/mainforce` 参数 view=blocks|stocks, type_code=1|2|4, block_code可选（stocks过滤成分）, period=1|3|5|10|34|55, end可选YYYY-MM-DD, q可选, sort默认-main_net, page=1,size=50（最大200）。返回 items,total,as_of,start,period,days,source,note,block_name（可空）。

行字段：key,name,symbol（股票或空）,block_code（板块或空）,members,covered,expected,main/medium/small={net:number|null,participation:number|null,ratio:number|null},continuous_inflow_days:number|null,streak_capped:boolean,change_rate:number|null,limit_up_count:number|null,top_stock_name:string|null,top_stock_symbol:string|null。covered为选中窗口有资金记录的成分股日数量，expected为成员数*实际交易日数；net缺值不当零，比例分母数据不齐时返回null。股票members=1。涨停家数和涨幅按资金截止日行情，不使用更新日快照。

days为交易日期字符串数组。无板块过滤的个股页使用stock_universe全池；不会被隐藏分类限制。成交额优先同日日线amount，缺失/零值使用同日daily_valuation.amount，绝不跨日填充。

## 实库验证与限制

- 导入1241板块、142996条本地A股成分关系、5555只股票。源文件本地保存在data/zy_block_config.xml，导入元数据data/zy_block_import.json；均不入Git。
- 一级行业39，子行业121，概念750、地域32、风格32、题材222、雷达45。白酒19、保险5；食品饮料子级6个。重复父子成分已去重。
- 最新本地资金截止2026-10-29。保险主力714409450.66元，介入度0.0384330793%，占比45.1583397488%，资金覆盖5/5；与资金卡使用相同capital_flow记录。
- 实测HTTP200：一级行业、子行业、白酒成员、主力介入度排序、白酒5日成员资金。行业1日0.5–2.7秒，白酒成员约0.1秒；数据源及本机负载影响耗时。
- 39行业1日主力占比32个可计算，其余分母不完整返回空；5/10/34/55日部分估值/成交额缺失，净额可显示而比例可能为空。涨停家数缺同日精确快照返回空。没有触发全市场历史补行情。
- 审查修复：个股全池不受隐藏分类过滤；进入子行业重新联动首只股票。追加测试与前端构建验证。
- 浏览器工具在最终视觉验收阶段出现browser.user不可用及所有CUA入口超时，尚未取得最终页面截图；已请求用户刷新检查独立入口。此项不应标记视觉验证通过。
- 用户手动确认独立军情入口及行业排行出现，反馈涨幅难找、个股名称缺少。接口抽样确认个股名称完整（中国卫星/光洋股份/文投控股/贵州茅台/襄阳轴承）；已将涨幅前置到名称后，个股代码/名称分列并固定左侧，避免横向滚动丢失身份。此显示调整构建通过，最终视觉仍待用户复核。
- 最终相关测试24项通过（导入5、军情7、板块冒烟2、股东回归10）；git diff --check通过。服务健康检查200，真实接口5条场景均200。

排序：main_net,main_participation,main_ratio,medium_net,medium_participation,medium_ratio,small_net,small_participation,small_ratio,continuous_inflow_days,change_rate,limit_up_count,name（负号降序，空值始终末尾）。
