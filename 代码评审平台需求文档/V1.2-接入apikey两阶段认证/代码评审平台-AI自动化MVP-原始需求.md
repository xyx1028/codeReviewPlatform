

我现在有个需求，想讲这个给流程化，目前的现状是，每周负责代码评审的值班人员，从公司的devops运营平台（https://devops.kingdee.com:8000/?formId=home_page&code=1788848459fbfcd69feedccb3afd26ae）上导出，他所在组的所有成员的需求，按照Scrum团队以及发布窗口过滤本周需要发布的需求，然后导出excel表格，导入当前系统，然后拿到模版之后，以及提示词之后，拉取所需要分析分支的最新代码去分析，最后讲这个分析的结果在导入到系统中。

目前最明显的问题，每次都需要人工导入表格，在下载模版，复制提示词，以及拉取最新的代码太麻烦了

现在的需求是想要把这个流程做成一个自动化流程，只需要输入当前Scrum团队 和发布窗口 就能自动化完成。



目前已有的东西是

classifier:      provider: alibaba-cn    

  model: qwen3.6-flash    

  base:        url: https://dashscope.aliyuncs.com/compatible-mode/v1      

api:        key: sk-e2795b009b194d66a8d07b11c9035460

 

此外我希望这个是能够切换不同模型去让ai分析的不同模型分析的结果肯定是不同的，所以还需要一个模型管理界面去配置，以及去选择本批次使用哪个模型来，此外登入https://devops.kingdee.com:8000/?formId=home_page&code=1788848459fbfcd69feedccb3afd26ae这个公司网址应该是需要登入的 这一步可能景要考虑登入的场景 





![image-20260908142804895](/Users/kingdee/Library/Application Support/typora-user-images/image-20260908142804895.png)

