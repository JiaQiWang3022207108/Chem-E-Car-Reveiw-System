#include <cassert>
#include <cmath>
extern "C" int expected_pdf_count(int);
extern "C" unsigned package_issues(int,int,int,int,int,int,int);
extern "C" int review_status(int,int,int);
extern "C" int compare_metric(int,double,double);
int main() {
  assert(expected_pdf_count(1)==3);
  for (int r=2;r<=5;++r) assert(expected_pdf_count(r)==4);
  assert(expected_pdf_count(0)==-1 && expected_pdf_count(6)==-1);
  assert(package_issues(1,3,1,1,1,0,0)==0);
  assert(package_issues(3,4,1,1,1,1,0)==0);
  assert(package_issues(2,3,1,1,1,0,0)==(2u|64u));
  assert(package_issues(2,4,1,1,1,1,1)==4u);
  assert(package_issues(1,4,1,1,1,1,0)==(2u|64u));
  assert(package_issues(2,4,2,0,1,1,0)==(8u|16u));
  assert(review_status(0,0,45)==0);
  assert(review_status(1,3,45)==1);
  assert(review_status(0,1,45)==2 && review_status(0,0,0)==2);
  assert(compare_metric(0,0.3,0.345)==1);
  assert(compare_metric(0,0.345,0.345)==0);
  assert(compare_metric(1,0.345,0.345)==1);
  assert(compare_metric(4,2,1)==1);
  assert(compare_metric(5,2,1)==-1);
  assert(compare_metric(1,NAN,1)==-1);
  assert(compare_metric(1,INFINITY,1)==-1);
}
