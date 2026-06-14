"""往 Redis 插入 100 条测试数据（含中文、数字、混合内容）"""
import redis
import random
import json

r = redis.Redis(
    host='127.0.0.1',
    port=6379,
    password='!QAZ2wsx',
    decode_responses=True
)

# ---- 素材库 ----
surnames = ['张', '李', '王', '赵', '陈', '杨', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '林', '郭', '何', '高', '罗', '郑']
names = ['伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '洋', '勇', '军', '杰', '涛', '明', '超', '秀兰', '桂英', '秀珍', '凤英', '玉兰']
cities = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '重庆']
provinces = ['广东', '浙江', '江苏', '山东', '河南', '四川', '湖北', '湖南', '福建', '安徽']
products = ['笔记本电脑', '无线耳机', '机械键盘', '显示器', '移动硬盘', '手机壳', '充电宝', 'U盘', '摄像头', '鼠标垫']
brands = ['华为', '小米', '苹果', '三星', '联想', '戴尔', '华硕', '惠普', '索尼', 'OPPO']
statuses = ['待付款', '已付款', '已发货', '已完成', '已取消', '退款中']
comments = [
    '质量很好，物流很快！',
    '性价比不错，值得购买。',
    '东西收到了，还没用，先给好评。',
    '一般般吧，不太满意',
    '第二次购买了，一如既往的好',
    '包装完好，没有破损',
    '颜色和图片有点色差',
    '用了一段时间，感觉还行',
    '推荐购买，比实体店便宜',
    '客服态度很好，有问必答',
    '物流太慢了，等了好久',
    '帮朋友买的，他说还不错',
]

# 1. 50 条用户信息 (String -> JSON)
for i in range(50):
    key = f'user:{i:03d}'
    name = random.choice(surnames) + random.choice(names)
    user_data = {
        'name': name,
        'age': random.randint(18, 65),
        'city': random.choice(cities),
        'province': random.choice(provinces),
        'phone': f'138{random.randint(10000000, 99999999)}',
        'email': f'{name}@example.com',
        'balance': round(random.uniform(0, 9999.99), 2),
        'reg_time': f'202{random.randint(0,5)}-{random.randint(1,12):02d}-{random.randint(1,28):02d}',
    }
    r.set(key, json.dumps(user_data, ensure_ascii=False))

# 2. 30 条商品订单 (String -> JSON)
for i in range(30):
    key = f'order:{i:03d}'
    order = {
        '商品': random.choice(products),
        '品牌': random.choice(brands),
        '数量': random.randint(1, 5),
        '单价': round(random.uniform(9.9, 4999), 2),
        '状态': random.choice(statuses),
        '收货地址': random.choice(cities) + random.choice(['朝阳区', '浦东新区', '天河区', '南山区', '西湖区']) + '某某路' + str(random.randint(1, 200)) + '号',
        '下单时间': f'202{random.randint(3,6)}-{random.randint(1,12):02d}-{random.randint(1,28):02d} {random.randint(8,22):02d}:{random.randint(0,59):02d}:{random.randint(0,59):02d}',
    }
    r.set(key, json.dumps(order, ensure_ascii=False))

# 3. 20 条评论 (List)
for i in range(20):
    r.lpush('comments:hot',
        f'{random.choice(surnames)}{"*" * random.randint(1,2)}：{random.choice(comments)}')

# 4. 一些杂项 String
r.set('config:site_name', '数据管理平台')
r.set('config:version', 'v3.2.1')
r.set('config:max_upload_mb', '50')
r.set('stats:total_users', str(random.randint(10000, 99999)))
r.set('stats:today_visits', str(random.randint(500, 5000)))
r.set('cache:banner', json.dumps({
    'title': '限时秒杀！全场5折起',
    'subtitle': '活动时间：6月10日-6月18日',
    'url': '/promo/618',
    'image': '/img/banner_618.jpg',
}, ensure_ascii=False))

# 5. 一个 Set
r.sadd('tags:热门', '新品', '爆款', '限时优惠', '包邮', '7天无理由', '正品保证', '24小时发货')

print(f'插入完成！当前共 {r.dbsize()} 个 key')
print(f'  user:*     : {len(r.keys("user:*"))} 个 Hash')
print(f'  order:*    : {len(r.keys("order:*"))} 个 JSON')
print(f'  comments:hot : {r.llen("comments:hot")} 条评论')
print(f'  tags:热门   : {r.scard("tags:热门")} 个标签')
print(f'  config/stats : {len(r.keys("config:*")) + len(r.keys("stats:*")) + len(r.keys("cache:*"))} 个杂项')

