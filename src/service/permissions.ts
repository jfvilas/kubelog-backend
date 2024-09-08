/*
Copyright 2024 Julio Fernandez

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { LoggerService } from "@backstage/backend-plugin-api";
import { ClusterPods, PodAccess } from "@jfvilas/plugin-kubelog-common";
import { KubelogPodPermissions, KubelogStaticData, PodPermissionRule } from "../model/KubelogStaticData";

export enum KWIRTH_SCOPE {
    filter=1,
    view,
    restart,
    api,
    cluster
}

const checkNamespaceAccess = (cluster:ClusterPods, pod:PodAccess, userEntityRef:string, userGroups:string[]):boolean => {
    var namespacePermissions=KubelogStaticData.clusterKubelogData.get(cluster.name)?.namespacePermissions;
    var allowedToNamespace=false;

    var rule=namespacePermissions?.find(ns => ns.namespace===pod.namespace);
    if (rule) {
        if (rule.identityRefs.includes(userEntityRef.toLowerCase())) {
            // a user ref has been found on a namespace rule
            allowedToNamespace=true;
        }
        else {
            var joinResult=rule.identityRefs.some(identityRef => userGroups.includes(identityRef));
            if (joinResult) {
                // a group ref match has been found
                allowedToNamespace=true;
            }
        }
    }
    else {
        // no restrictions for this namespace
        allowedToNamespace=true;
    }
    return allowedToNamespace;
}

const checkPodPermissionRule = (ppr:PodPermissionRule, reqPod:PodAccess, userEntityRef:string, userGroups:string[]):boolean => {
    var refMatch:boolean=false;

    for (var podNameRegex of ppr.pods) {
        if (podNameRegex.test(reqPod.name)) {
            for (var refRegex of ppr.refs) {
                // find userRef
                if (refRegex.test(userEntityRef.toLowerCase())) {
                    refMatch=true;
                    console.log(`pod ${reqPod.name} matches ${podNameRegex.source}, ref ${userEntityRef.toLocaleLowerCase()} matches ${refRegex.source}`)
                    break;
                }
                else {
                    // find group ref
                    refMatch = userGroups.some(g => refRegex.test(g));
                    console.log(`pod ${reqPod.name} matches ${podNameRegex.source}, ref ${userEntityRef.toLocaleLowerCase()} matches ${refRegex.source}`)
                    break;
                }
            }
        }
        if (refMatch) break;
    }
    if (!refMatch) console.log(`pod ${reqPod.name}, ref ${userEntityRef.toLocaleLowerCase()} have no match, returning false`)
    return refMatch;
}

/**
 * This funciton checks permissions according to app-config rules (not kwirth rules), that is, namespace rules,
 * viewing rules and restarting rules
 * @param reqScope the scope the user is requesting
 * @param reqCluster the cluster the pod belongs to
 * @param reqPod data about the pod the user wants to access
 * @returns booelan indicating if the user can access the pod for doing what scaope says (view or restart)
 */
const checkPodAccess = (loggerSvc:LoggerService, reqScope:KWIRTH_SCOPE, reqCluster:ClusterPods, reqPod:PodAccess, userEntityRef:string, userGroups:string[]):boolean => {
    console.log('\n\n');
    console.log(`Checking '${reqScope}' scope in cluster ${reqCluster.name} for pod: ${reqPod.namespace+'/'+reqPod.name}`);
    console.log('requiredScope', reqScope);
    var cluster = KubelogStaticData.clusterKubelogData.get(reqCluster.name);

    if (!cluster) {
        loggerSvc.warn(`Invalid cluster specified ${reqCluster.name}`);
        return false;
    }

    var podPermissions:KubelogPodPermissions[];
    if (reqScope===KWIRTH_SCOPE.view) {
        podPermissions=cluster.viewPermissions;
    }
    else if (reqScope===KWIRTH_SCOPE.restart) {
        podPermissions=cluster.restartPermissions;
    }
    else {
        loggerSvc.warn(`Invalid scope requested: ${reqScope}`);
        return false;
    }

    console.log(JSON.stringify(reqCluster));
    console.log(reqPod);
    console.log(podPermissions);
    console.log('\n\n');

    // we check all pod permissions until one of them evaluates to true (must bew true on allow/except and false on deny/unless)
    for (var podPermission of podPermissions) {
        console.log(`Testing ns: ${podPermission.namespace}`);
        if (podPermission.allow) {
            
            // **** validate allow/except rules ****
            var allowMatches=false;
            var exceptMatches=false;
            // we test all allow rules, we stop if one matches
            for (var prr of podPermission.allow) {
                allowMatches = checkPodPermissionRule(prr, reqPod, userEntityRef, userGroups);
            }
            if (allowMatches && podPermission.except) {
                // we test all except rules, will stop if found one that matches, no need to continue
                for (var prr of podPermission.except) {
                    exceptMatches = checkPodPermissionRule(prr, reqPod, userEntityRef, userGroups);
                    if (exceptMatches) break;
                }
            }

            if (allowMatches && !exceptMatches) {
                // **** validate deny/unless rules ****
                if (podPermission.deny) {
                    var denyMatches=false
                    var unlessMatches=false
                    for (var prr of podPermission.deny) {
                        denyMatches = checkPodPermissionRule(prr, reqPod, userEntityRef, userGroups)
                    }
                    if (denyMatches && podPermission.unless) {
                        for (var prr of podPermission.unless) {
                            unlessMatches = checkPodPermissionRule(prr, reqPod, userEntityRef, userGroups)
                        }
                    }
                    if (!denyMatches || (denyMatches && unlessMatches)) {
                        console.log(`allow(${allowMatches}) except(${exceptMatches}) // deny (${denyMatches}) unless (${unlessMatches}): TRUE`)
                        return true
                    }
                }
                else {
                    console.log(`allow(${allowMatches}) except(${exceptMatches}) // not deny/unless: TRUE`)
                    return true
                }
            }
            else {
                // do nothing, just continue podpermissions loop
            }
        }
    }
    
    console.log(`FOUND NO VALID MATCH: FALSE`)
    return false;
}

export { checkNamespaceAccess, checkPodAccess }