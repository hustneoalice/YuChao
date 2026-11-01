# 强势调整：眼睛、箭头和保护线的绘图路径

## 范围

Mac安装包 `/Applications/众赢财富通.app/Wrapper/zytg.app/zytg` 的静态反汇编与Objective-C元数据。绘图结果没有通过运行时参数快照验证，以下把已读清的数据流与未知上游选择分开。未修改yuchao功能。

## 同组眼睛和箭头起点的统一

`ZYCanvasModel qstzModelRedressal` 0x100104090启动异步整理，block位于0x100104130。没有icons时直接退出。其余路径：

```
D = empty dictionary
for icon in icons:
    if icon.time != nil and icon.value != nil:
        D[icon.time] = icon.value
for arrow in arrows:
    t = arrow.start.time
    v = min(arrow.start.value, arrow.end.value)
    if D[t] < v: v = D[t]
    D[t] = v
for arrow in arrows:
    arrow.start.value = D[arrow.start.time]
for icon in icons:
    icon.value = D[icon.time]
```

比较来自NSNumber compare，0x1001043f4先取两个端点较小值，0x100104410再与字典已有值取更小值。此为正常完整数据的伪代码，Objective-C nil和重复icon时间覆盖行为应保留在等价实现中。

这说明同一start.time的多根箭头共享统一的起点高度，眼睛图标也移动到该高度；它没有删除重复icon对象、没有按日期距离重新生成连接，不能把坐标统一称为已证明的去重。

## 像素坐标与屏幕裁剪

`ZYScaler updateArrowsWithRange:` 0x10017c538：

- 分别通过时间到K线索引的字典定位start/end。
- 检查start索引是否处于可视range；要求start.time存在于上述D。
- 共享起点值低于当前图表min时，绘图时钳制到min，并在mEyeMoveDic记录该时间的移动标志。
- start.x、end.x由convertToXaxisFromIndex换算，start.y由共享D值映射，end.y由arrow.end.value映射并叠加与shapeWidth有关的像素偏移。
- ArrowShape存线宽、两端像素坐标、颜色；遍历传入arrows并将可见对象加入绘制数组。未发现每组前三根/仅第一根/总根数上限规则。可视范围过滤不等于业务信号筛选。

`ZYScaler updateIconsWithRange:` 0x10017cafc：

- icon通过time映射到K线index，再换算x/value/relative对应的y，构造frame。
- 代码明确对item_code==`i_qstz`有特殊路径（CFString地址0x1016ce480）。当图标落在K线中点下方且mEyeMoveDic存在该时间时，y钳制到图表min映射的屏幕位置，与箭头起点一致。
- 另有`i_zsdd`分支，不能混同强势调整。
- native ZYIcon持有icon、value、time、tag、offset、frame等字段。安装包Flutter资源也存在`ic_indicator_eye.png`，肉眼确认是棕色眼睛图片；尚未证明native这条路径使用同一资源文件，不应据此硬定原图尺寸。

## 保护线

`ZYScaler updatebaohuLinesWithRange:` 0x10017e040遍历curves和各curve.data，按时间映射索引、按ggValue换算价格坐标，构造线段点缓冲区，并携带title/color/value信息。

这里消费的是已生成的曲线数据，没有恢复出“遇到哪根K线结束保护线”的业务判断；仅靠该渲染函数不能证明保护线一定延伸至最新一天、跌破终止或新涨停终止。保护价如何由涨停低点生成也不在此段。

## 上游数据来源的新证据

`requestIndicator:forSymbol:period:isNeedSwitchPeriod:` 0x10027ab30区分is_native分支：

- native分支调用qmCanvasDataFor:quoteInfo:from:finishHandler:。
- 另一分支在0x10027ad7c调用qmSymbol:pattern:period:success:onError:；成功block0x10027af10接收已有图表模型，在0x10027aff4调用qstzModelRedressal，再mapIndicatorModel和updateIndicator。
- qmSymbol实现0x1001584b4通过getPath:params:onSuccess:onError:请求`https://api.zhongyingtougu.com/api/v2/sc/qm/{symbol}/{pattern}`，请求参数包含period，success用yy_modelWithJSON解析模型。

这确立了“请求返回图表模型 → 眼睛/箭头位置整理 → 渲染”的一条代码路径。尚未读取当前i_qstz实例is_native属性，不能宣称所有版本的眼睛都只由服务端计算。未发送该接口请求，未读取或复制认证凭据。

## DLL包含的信息比此前摘要更多

`Qiangshitiaozheng.dll`只有一个公开计算编号ID1，但内部包括：

1. H/L/C驱动的1–43形态状态分派。
2. 涨停后的高低价与计时状态，多个中止/失效分支。
3. 成交量120递推平滑、收盘价60递推平滑。
4. 多种买卖返回码。静态直接写入浮点值中发现1–12、100–110、112–114；这是“已观察到的写入常量”，不是已穷尽的可达返回码清单，不能把常量逐个命名成策略。
5. 持有状态与后续退出判断。系统调用公式按0<bs<100和bs>=100划分向上/向下图标。

一个导出函数不等于只有一个判断条件；43状态不等于43个独立特色指标。这个Windows DLL未发现time/start/end/eye/curve等图表模型输出接口；其标量返回不直接携带多根箭头或保护线几何数据，仍未建立与独立眼睛生成器的直接关系。

## 对yuchao的含义

眼睛定位可以依照已恢复规则替代此前人为设置的价格比例偏移；但不能将原渲染规则误当成触发算法。现有连线过密应优先核对上游命中集合和分组终止条件，而不是随意限制每组根数。当前还缺真实i_qstz模型样本（icons/arrows/curves）与其生成路径的参数/运行证据。

反汇编和选择器注释位于`zhongying-windows/mac-qstz-*.annotated.txt`；辅助脚本annotate-mac-selectors.py仅做本地静态解析。

## 用户补充与后续判断边界

用户明确：连线表示有效，失效则不连线。后续应恢复每个涨停组的有效状态与失效条件，不以每组最多几根或额外再启动形态作为未经证实的限制。单日无连线是否意味着整组永久结束，仍需原版输出或规则证据；该补充本身没有给出可恢复的阈值。

对静态发现的模型接口进行一次不带认证的读取（002812/i_qstz，period=day），系统curl正常验证TLS后HTTP401，无模型正文。未尝试绕过认证、未查找凭据。Python默认CA链失败后切换系统curl，未关闭证书校验。period与symbol的实际客户端编码仍未运行核对，该请求仅证明此直接入口未返回未认证模型，不证明已成功复现完整客户端请求。

已有候选不能称为原版有效性规则：恩捷2月10日量比45.63%却在已提供原图连线区间内；若坚持<=50%立即终组会与该原图样本冲突。DLL买卖输出在4月28日为0也不能当作眼睛无效证据。需要从已登录原软件取得对应模型/有效区间，或通过原版图表多组边界样本验证具体失效规则。
