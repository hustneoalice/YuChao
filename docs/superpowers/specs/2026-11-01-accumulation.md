# 主力吸筹接入设计（用户已确认）

在现有 K 线副图选择器量能分类新增主力吸筹，使用紫色空心柱。不新增买卖建议或自动交易。计算取自本机众赢财富通 4.1.14 的 sys_index1.xml，属于公式移植，未确认当前原应用使用该资源，未逐点对照 Windows 版。

公式如下：
```
VAR2:=REF(LOW,1);
VAR3:=SMA(ABS(LOW-VAR2),3,1)/SMA(MAX(LOW-VAR2,0),3,1)*100;
VAR4:=EMA(IF(CLOSE*1.2,VAR3*10,VAR3/10),3);
VAR5:=LLV(LOW,38);
VAR6:=HHV(VAR4,38);
VAR7:=IF(LLV(LOW,90),1,0);
VAR8:=EMA(IF(LOW<=VAR5,(VAR4+VAR6*2)/2,0),3)/618*VAR7;
ST01:STICKLINE(1,VAR8 ,0,4 ,1 ),COLORF000FF,NOTITLE;
主力进场:=VAR8; 
DD:=VAR8>5;
```

仅使用 high/low/close 行情；SMA(X,3,1) 递推系数 1/3、EMA(X,3) 系数 1/2；REF 首日取当前低价，滚动窗口不足使用已有数据。分母为零时输出空值，递推在出现有效值后初始化，不产生无穷大。这些初始化和零除语义是显式实现选择，仍需原软件对照。

验证：手算样本、低点触发与衰减、横盘零除、历史前缀稳定性；TypeScript 与生产构建；浏览器检查副图接入。
