package connector

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/ongridio/ongrid/internal/cmdb/biz/classmap"
)

type fakeClassTarget struct {
	classes []classmap.Class
	created bool
	failAt  int
	calls   int
}

func (f *fakeClassTarget) EnsureClass(_ context.Context, class classmap.Class) (bool, error) {
	f.calls++
	if f.failAt > 0 && f.calls == f.failAt {
		return false, errors.New("target rejected class")
	}
	f.classes = append(f.classes, class)
	return f.created, nil
}

func classPlan(mappings ...classmap.Mapping) classmap.Report {
	return classmap.Report{Types: len(mappings), Mappings: mappings}
}

func TestApplyClassesOrdersParentsFirst(t *testing.T) {
	plan := classPlan(
		classmap.Mapping{SourceModel: "rack", TargetClass: "Rack",
			Class: classmap.Class{ClassName: "Rack", ParentClass: "Room"}},
		classmap.Mapping{SourceModel: "room", TargetClass: "Room",
			Class: classmap.Class{ClassName: "Room"}},
	)
	target := &fakeClassTarget{created: true}
	report, err := ApplyClasses(context.Background(), plan, target)
	if err != nil {
		t.Fatalf("ApplyClasses() error = %v", err)
	}
	if report.Classes != 2 || report.Created != 2 || report.Updated != 0 {
		t.Fatalf("report = %+v", report)
	}
	if len(target.classes) != 2 || target.classes[0].ClassName != "Room" ||
		target.classes[1].ClassName != "Rack" {
		t.Fatalf("order = %+v", target.classes)
	}
}

func TestApplyClassesRejectsBlockedPlanBeforeWriting(t *testing.T) {
	plan := classPlan(classmap.Mapping{
		SourceModel: "host", TargetClass: "Host",
		Class:      classmap.Class{ClassName: "Host"},
		Unresolved: "bad attribute",
	})
	plan.Blocked = true
	plan.Unresolved = 1
	target := &fakeClassTarget{created: true}

	_, err := ApplyClasses(context.Background(), plan, target)
	if !errors.Is(err, ErrPlanBlocked) {
		t.Fatalf("error = %v, want ErrPlanBlocked", err)
	}
	if target.calls != 0 {
		t.Fatalf("target was called for a blocked plan: %+v", target)
	}
}

func TestApplyClassesReportsPartialFailure(t *testing.T) {
	plan := classPlan(
		classmap.Mapping{SourceModel: "room", TargetClass: "Room",
			Class: classmap.Class{ClassName: "Room"}},
		classmap.Mapping{SourceModel: "rack", TargetClass: "Rack",
			Class: classmap.Class{ClassName: "Rack", ParentClass: "Room"}},
	)
	target := &fakeClassTarget{created: true, failAt: 2}

	report, err := ApplyClasses(context.Background(), plan, target)
	if err == nil || !strings.Contains(err.Error(), "Rack") {
		t.Fatalf("error = %v, want a contextual failure", err)
	}
	if report == nil || report.Created != 1 {
		t.Fatalf("report = %+v", report)
	}
}

func TestApplyClassesRejectsInheritanceCycle(t *testing.T) {
	plan := classPlan(
		classmap.Mapping{SourceModel: "a", TargetClass: "A",
			Class: classmap.Class{ClassName: "A", ParentClass: "B"}},
		classmap.Mapping{SourceModel: "b", TargetClass: "B",
			Class: classmap.Class{ClassName: "B", ParentClass: "A"}},
	)
	_, err := ApplyClasses(context.Background(), plan, &fakeClassTarget{created: true})
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("error = %v, want an inheritance cycle", err)
	}
}
