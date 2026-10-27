package cantorimport

// cmdbTables is every CMDB table this port owns, in copy order.
//
// THE ORDER IS FOR THE OPERATOR, NOT FOR FOREIGN KEYS. The target schema
// declares no database-level FKs (see internal/cmdb/model/const.go), so a table
// can be copied in any order; the order still matters when a person reads the
// report, and it keeps the parent rows ahead of their children if a future
// schema adds a constraint.
//
// The list deliberately excludes:
//   - c_schema_meta, which is the target's lineage, not cantor data;
//   - c_c_d, c_dashboard, c_data_source and c_kv/c_sc (dashboards, BI and raw
//     configuration are a separate Epic);
//   - c_ci_filter_perms and the c_cfp/ACL family (permissions come from Ongrid
//     IAM);
//   - c_ad_counter, because the port computes the counters from c_ad_ci;
//   - c_value_integers, c_value_floats and c_value_datetime, which cantor
//     marks deprecated and never writes.
var cmdbTables = []string{
	"c_relation_types",
	"c_attributes",
	"c_ci_types",
	"c_ci_type_groups",
	"c_ci_type_group_items",
	"c_ci_type_attributes",
	"c_ci_type_attribute_groups",
	"c_ci_type_attribute_group_items",
	"c_ci_type_inheritance",
	"c_ci_type_relations",
	"c_c_t_t",
	"c_c_t_u_c",
	"c_cis",
	"c_ci_relations",
	"c_value_index_integers",
	"c_value_index_floats",
	"c_value_index_texts",
	"c_value_index_datetime",
	"c_value_texts",
	"c_value_json",
	"c_choice_integers",
	"c_choice_floats",
	"c_choice_texts",
	"c_records",
	"c_attribute_histories",
	"c_relation_histories",
	"c_ci_type_histories",
	"c_ci_trigger_histories",
	"c_psa",
	"c_pcto",
	"c_ptv",
	"c_prv",
	"c_pso",
	"c_pasc",
	"c_topology_view_groups",
	"c_topology_views",
	"c_ad_rules",
	"c_ad_ci_types",
	"c_ad_ci_type_relations",
	"c_ad_accounts",
	"c_ad_ci",
	"c_ad_rule_sync_histories",
	"c_ad_exec_histories",
	"c_ipam_subnet_scans",
	"c_ipam_subnet_scan_histories",
	"c_ipam_operation_histories",
	"c_dcim_operation_histories",
}

var cmdbTableSet = func() map[string]bool {
	out := make(map[string]bool, len(cmdbTables))
	for _, table := range cmdbTables {
		out[table] = true
	}
	return out
}()

func isCMDBTable(table string) bool { return cmdbTableSet[table] }
