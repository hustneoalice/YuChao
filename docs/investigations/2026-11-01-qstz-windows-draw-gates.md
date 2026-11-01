# Windows强势调整：绘制前判断与箭头表来源

## 本轮新证据

取得当前安装目录chart.dll、CloudEngine.dll和Allwin.exe进行静态检查。没有执行这些新增模块，没有修改yuchao应用。

### chart.dll中直接控制“不画”的分支

CCloudArrowDrawer::DrawNodes 0x1004cd80：

- 没有输入节点时返回。
- 逐节点检查IsNodeNull（0x10057a70）、IsNodeInvalid（0x10057ab0）、IsNodeDivide（0x10057af0）。对应CNodeDrawerData+0x28标志位0x20、0x01、0x10，任一为真则跳过当前节点。
- 0x1004d0b8按当前节点时间查箭头容器；0x1004d146比较查找结果与end迭代器。未找到则跳过。
- 找到start后遍历该start下的end容器；结束于该end容器的end迭代器，说明一个start可画多条。
- 每个end映射到可见节点位置，完成价格到像素转换和裁剪后，调用GdipDrawLineI画主线、DrawTriangle画箭头。找不到对应可见节点时跳过该end。
- BeNoDraw@CCloudArrowDrawer在0x10006060固定返回0，没有额外业务判断；该地址被多个空方法合并，不能把objdump显示的别名误认作另一函数。

正常数据路径可概括为：

```
for node in visibleNodes:
    if node.flags & (0x20 | 0x01 | 0x10): continue
    entry = arrowTable.find(node.time)
    if entry == arrowTable.end(): continue
    for endpoint in entry.endpoints:
        target = findVisibleNode(endpoint.time)
        if target is absent: continue
        drawArrow(entry.start.value, endpoint.value, target.position)
```

上述为静态还原摘要，不是全部图形裁剪和缺失值语义的等价实现。

### 无效标志的写入追踪

CNodeDrawerData(CNodeData const&) 0x1000a7a0调用TechIndex.dll的CNodeData拷贝构造。该构造经CNodeData::Set 0x1008d5e0，将源对象+0x28标志原样复制到目标+0x28（0x1008d653..0x1008d65c）。此路径没有读取量比、MA45、涨停最低价重新计算“失效”。

这证实绘图前有条件，不能说前端绝无判断；但IsNodeInvalid属于共用图表节点有效性检查，尚不能证明它等于“强势调整有效性”。更有针对性的选择是箭头表中是否存在该时间和对应end。

### CloudEngine.dll中的i_qstz专门分支

- T_CloudResult::Filed 0x10047850，在0x10047903开始检查/读取JSON的arrows字段，存入对象+0xac，并调用T_CloudArrow的JSON解析入口0x10007f40。
- T_CloudArrow JSON解析遍历每条输入，读取start/end对象与value，读取color，然后Insert(start,end)。当前看到的该路径没有遍历K线计算新的价格/成交量条件。
- GetVirtualGraphic 0x100480f0，在0x10048ac2比较指标code是否i_qstz；匹配时将对象+0xac中的箭头数据包装为绘图对象。0x10045630是持有该指针的包装构造，而非形态计算函数。

因此Windows链路已更完整：结果JSON.arrows → 解析为起点/终点表 → i_qstz专门包装 → DrawNodes的节点有效性检查 → 查表后画线。

### 刷新合并

T_CloudArrow::OverlayAfterTime 0x10009ff0带时间截止参数：新箭头表为空则直接返回；非空路径对旧表迭代器及64位时间比较，随后区间处理并调用operator+合并新表。当前已确认属于按时间合并路径，erase区间及其实际调用参数仍需继续核对，暂不据此推导业务“有效期”或宣称是连线过多根因。

### JS路径范围

Allwin导入InitCloudIndexByJS，CloudEngine引用./v8-handler/code.json、kline.json。读取code.json成功，仅列i_lnhy、i_gjhy两个指标，不含i_qstz。node.js.code为目录，清单仅cloud.js；其定向复制未完成，不能声称已分析该文件。未读取auth.json或认证凭据。

## 当前结论和下一步

已经找到用户要求的绘制前判断，并向上追到i_qstz的箭头表来源。还没有恢复“根据OHLCV决定JSON里应有哪些end”的形态有效性条件。下一步应该定位产生或更新arrows结果的具体路径，并核对原软件样本中的start/end/节点标志；不应把共用invalid标志、显示范围过滤或买卖DLL输出强行当成眼睛失效规则。

本轮证据：windows-cloud-arrow-draw.annotated.txt、windows-node-flags.txt、windows-arrow-json.annotated.txt、windows-cloud-result-fields.txt、windows-qstz-graphic-gate.txt、windows-arrow-overlay.txt。
