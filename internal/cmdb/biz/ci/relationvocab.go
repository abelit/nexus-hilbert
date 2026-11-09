package ci

// RelationTypeSpec is one word in the managed relation vocabulary: the CMDB
// mirror of a nexus-topocortex relation type.
//
// The split command creates a word when a live rule needs it, and the built-in
// bootstrap creates the words its own rules need on a fresh database. Both
// paths share this definition so the semantics cannot drift between a migrated
// database and a bootstrapped one.
type RelationTypeSpec struct {
	Name, Category, Direction string
	DisplayZH, DisplayEN      string
	Description               string
	InverseOf                 string
	Propagates                bool
	Transitive                bool
	Weight                    float64
}

// TargetRelationTypes is the post-split vocabulary. Direction-safe words are
// created as-is; structural and contract words are the CMDB-side inverse of
// the topocortex target and declare inverse_of (CMDB stores whole -> part and
// contract -> resource; the connector reverses the endpoints).
//
// The slice is ordered so a migration report lists types deterministically.
func TargetRelationTypes() []RelationTypeSpec {
	return []RelationTypeSpec{
		{
			Name: "RUNS_ON", Category: "runtime", Direction: "dst_to_src",
			DisplayZH: "运行于", DisplayEN: "Runs on",
			Description: "运行于：工作负载运行在宿主上，宿主故障影响工作负载。",
			Propagates:  true, Weight: 1.0,
		},
		{
			Name: "DEPENDS_ON", Category: "dependency", Direction: "dst_to_src",
			DisplayZH: "依赖", DisplayEN: "Depends on",
			Description: "依赖：源依赖目标，目标故障影响源。",
			Propagates:  true, Weight: 0.8,
		},
		{
			Name: "CALLS", Category: "dependency", Direction: "dst_to_src",
			DisplayZH: "调用", DisplayEN: "Calls",
			Description: "服务调用：调用方调用被调用方，目标故障影响源；同步 API/RPC 调用使用该类型。",
			Propagates:  true, Weight: 0.9,
		},
		{
			Name: "POWERED_BY", Category: "failure-domain", Direction: "dst_to_src",
			DisplayZH: "供电于", DisplayEN: "Powered by",
			Description: "供电依赖：消费者由供电方供电，供电故障影响消费者。",
			Propagates:  true, Weight: 1.0,
		},
		{
			Name: "CONNECTS_TO", Category: "dependency", Direction: "dst_to_src",
			DisplayZH: "连接", DisplayEN: "Connects to",
			Description: "逻辑连接：协议与调用语义待 APM 证据补充。",
			Propagates:  true, Weight: 0.6,
		},
		// Structural types are the CMDB-side inverse of the topocortex target:
		// CMDB stores whole -> part, topocortex PART_OF reads part -> whole.
		{
			Name: "CONTAINS", Category: "structure", Direction: "src_to_dst",
			DisplayZH: "包含", DisplayEN: "Contains",
			Description: "结构包含：整体由部分组成，不传播故障。",
			InverseOf:   "PART_OF", Transitive: true, Weight: 0,
		},
		{
			Name: "HAS_MEMBER", Category: "structure", Direction: "src_to_dst",
			DisplayZH: "含有成员", DisplayEN: "Has member",
			Description: "成员聚合：聚合体含有成员，不传播故障。",
			InverseOf:   "MEMBER_OF", Weight: 0,
		},
		{
			Name: "HAS_BELONGING", Category: "structure", Direction: "src_to_dst",
			DisplayZH: "含有归属", DisplayEN: "Has belonging",
			Description: "业务归属：分组含有归属资源，不传播故障。",
			InverseOf:   "BELONGS_TO", Weight: 0,
		},
		{
			Name: "HAS_LOCATION", Category: "structure", Direction: "src_to_dst",
			DisplayZH: "含有位置", DisplayEN: "Has location",
			Description: "物理位置：位置含有设备，不传播故障。",
			InverseOf:   "LOCATED_IN", Weight: 0,
		},
		{
			Name: "ALLOCATES", Category: "structure", Direction: "src_to_dst",
			DisplayZH: "分配", DisplayEN: "Allocates",
			Description: "地址分配：子网分配地址，不传播故障。",
			InverseOf:   "ALLOCATED_TO", Weight: 0,
		},
		{
			Name: "COVERS", Category: "ownership", Direction: "src_to_dst",
			DisplayZH: "合同覆盖", DisplayEN: "Covers",
			Description: "合同覆盖：SLA/合同覆盖资源，不传播故障。",
			InverseOf:   "UNDER_CONTRACT", Weight: 0,
		},
	}
}

// TargetRelationType returns one vocabulary word by name.
func TargetRelationType(name string) (RelationTypeSpec, bool) {
	for _, spec := range TargetRelationTypes() {
		if spec.Name == name {
			return spec, true
		}
	}
	return RelationTypeSpec{}, false
}
