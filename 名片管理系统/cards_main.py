
action_str = input("请选择希望执行的操作：")
print("你选择的操作是【%s】" % action_str)

#1,2,3 针对名片的操作
if action_str in ["1", "2", "3"]:
    pass
#0 退出系统
elif action_str == "0":
    pass
#其他内容输入错误，需提示用户
else:
    print("你选择的不正确，请重新选择")


